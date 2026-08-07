import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createProject,
  createFeature,
  createTask,
  deleteFeature,
  getFeature,
  getTask,
  updateFeature,
  updateProject,
  listFeatures,
  getFeatureDeps,
  getFeatureDependents,
  setFeatureDeps,
  featureDepsSatisfied,
} from "@/lib/store";
import { approvePlan, kickoffDependents } from "@/lib/approvePlan";
import { createSuggestedFeature } from "@/lib/agentTools";
import { makeRepo, uid } from "./helpers";

// approvePlan arms the controller and kicks a detached sweep — real scheduling
// that would spawn actual agent turns from a unit test (driveFeature step 2 →
// startInitialTurn → the real driver). Mock the two entry points; the
// controller's own wiring is pinned by tests/autopilotRun.test.ts.
vi.mock("@/lib/autopilot", () => ({ ensureAutopilot: vi.fn(), sweep: vi.fn().mockResolvedValue(undefined) }));

/** A project plus n features, freshly created. */
function fixture(n: number) {
  const p = createProject({ name: `FD-${uid()}` });
  const fs = Array.from({ length: n }, (_, i) => createFeature({ project_id: p.id, name: `F${i}-${uid()}` }));
  return { p, fs };
}

describe("setFeatureDeps / getFeatureDeps", () => {
  it("round-trips, dedupes, and drops self-references", () => {
    const { fs: [a, b] } = fixture(2);
    setFeatureDeps(b.id, [a.id, a.id, b.id]);
    expect(getFeatureDeps(b.id)).toEqual([a.id]);
    expect(getFeatureDependents(a.id)).toEqual([b.id]);
    // Replace semantics: a second call swaps the set, not appends.
    setFeatureDeps(b.id, []);
    expect(getFeatureDeps(b.id)).toEqual([]);
  });

  it("drops ids from another project", () => {
    const { fs: [a] } = fixture(1);
    const other = createFeature({ project_id: createProject({ name: `FD2-${uid()}` }).id, name: `X-${uid()}` });
    setFeatureDeps(a.id, [other.id]);
    expect(getFeatureDeps(a.id)).toEqual([]);
  });

  it("throws on a cycle", () => {
    const { fs: [a, b, c] } = fixture(3);
    setFeatureDeps(b.id, [a.id]);
    setFeatureDeps(c.id, [b.id]);
    expect(() => setFeatureDeps(a.id, [c.id])).toThrow("dependency cycle");
  });

  it("joins depends_on into listFeatures", () => {
    const { p, fs: [a, b] } = fixture(2);
    setFeatureDeps(b.id, [a.id]);
    const rows = listFeatures(p.id);
    expect(rows.find((f) => f.id === b.id)!.depends_on).toEqual([a.id]);
    expect(rows.find((f) => f.id === a.id)!.depends_on).toEqual([]);
  });
});

describe("featureDepsSatisfied", () => {
  it("is true only when every dep has shipped (merged_at > 0)", () => {
    const { fs: [a, b, c] } = fixture(3);
    setFeatureDeps(c.id, [a.id, b.id]);
    expect(featureDepsSatisfied(c.id)).toBe(false);
    updateFeature(a.id, { merged_at: Date.now() });
    expect(featureDepsSatisfied(c.id)).toBe(false); // b still unshipped
    updateFeature(b.id, { merged_at: Date.now() });
    expect(featureDepsSatisfied(c.id)).toBe(true);
  });

  it("archived-without-merge does NOT satisfy", () => {
    const { fs: [a, b] } = fixture(2);
    setFeatureDeps(b.id, [a.id]);
    updateFeature(a.id, { archived: 1 }); // abandoned, never shipped
    expect(featureDepsSatisfied(b.id)).toBe(false);
  });

  it("no deps = satisfied", () => {
    const { fs: [a] } = fixture(1);
    expect(featureDepsSatisfied(a.id)).toBe(true);
  });
});

// approvePlan reads ORCH_FEATURE_AUTOPILOT at call time (lib/features.ts).
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.ORCH_FEATURE_AUTOPILOT;
  process.env.ORCH_FEATURE_AUTOPILOT = "1";
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ORCH_FEATURE_AUTOPILOT;
  else process.env.ORCH_FEATURE_AUTOPILOT = savedFlag;
});

/** Project on a real repo + one feature with one suggested member. */
async function armFixture() {
  const repo = await makeRepo();
  const project = updateProject(createProject({ name: `AP-${uid()}` }).id, { repo_path: repo, branch: "main" })!;
  const feature = createFeature({ project_id: project.id, name: `APF-${uid()}` });
  const task = createTask({ project_id: project.id, title: "member", feature_id: feature.id, suggested: true });
  return { project, feature, task };
}

describe("approvePlan", () => {
  it("cuts the branch, accepts suggestions, and arms", async () => {
    const { project, feature, task } = await armFixture();
    const res = await approvePlan(feature, project);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("did-work");
    const f = getFeature(feature.id)!;
    expect(f.autopilot).toBe(1);
    expect(f.branch).not.toBe("");
    expect(getTask(task.id)!.suggested).toBe(0);
  });

  it("no-ops when ORCH_FEATURE_AUTOPILOT is off", async () => {
    process.env.ORCH_FEATURE_AUTOPILOT = "0";
    const { project, feature } = await armFixture();
    const res = await approvePlan(feature, project);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.outcome).toBe("flag-off");
    expect(getFeature(feature.id)!.autopilot).toBe(0);
  });

  it("skips entirely only when already armed; a pre-existing branch skips only the cut", async () => {
    const { project, feature, task } = await armFixture();
    // Pre-existing branch (e.g. cut via POST /branch): still accepts + arms.
    updateFeature(feature.id, { branch: "feature/pre-cut" });
    const res = await approvePlan(getFeature(feature.id)!, project);
    expect(res.ok && res.outcome === "did-work").toBe(true);
    const f = getFeature(feature.id)!;
    expect(f.branch).toBe("feature/pre-cut"); // not re-cut
    expect(f.autopilot).toBe(1);
    expect(getTask(task.id)!.suggested).toBe(0);
    // Already armed: skip everything.
    const again = await approvePlan(getFeature(feature.id)!, project);
    expect(again.ok && again.outcome === "already-armed").toBe(true);
  });
});

describe("kickoffDependents", () => {
  it("arms a dependent only when ALL its deps have shipped", async () => {
    const { project, feature: a } = await armFixture();
    const b = createFeature({ project_id: project.id, name: `B-${uid()}` });
    const c = createFeature({ project_id: project.id, name: `C-${uid()}` });
    createTask({ project_id: project.id, title: "b work", feature_id: b.id, suggested: true });
    setFeatureDeps(c.id, [a.id, b.id]); // diamond tail: c waits on both
    setFeatureDeps(b.id, [a.id]);

    updateFeature(a.id, { merged_at: Date.now(), archived: 1 }); // a ships
    const kicked = await kickoffDependents(a.id);
    expect(kicked.map((k) => k.featureId)).toEqual([b.id]); // c's deps not all shipped
    expect(getFeature(b.id)!.autopilot).toBe(1);
    expect(getFeature(c.id)!.autopilot).toBe(0);

    updateFeature(b.id, { merged_at: Date.now(), archived: 1 }); // b ships
    const kicked2 = await kickoffDependents(b.id);
    expect(kicked2.map((k) => k.featureId)).toEqual([c.id]);
    expect(getFeature(c.id)!.autopilot).toBe(1);
  });

  it("skips archived and already-armed dependents; idempotent on double ship", async () => {
    const { project, feature: a } = await armFixture();
    const armed = createFeature({ project_id: project.id, name: `AR-${uid()}` });
    const parked = createFeature({ project_id: project.id, name: `PK-${uid()}` });
    updateFeature(armed.id, { autopilot: 1, branch: "feature/already" });
    updateFeature(parked.id, { archived: 1 });
    setFeatureDeps(armed.id, [a.id]);
    setFeatureDeps(parked.id, [a.id]);

    updateFeature(a.id, { merged_at: Date.now() });
    expect(await kickoffDependents(a.id)).toEqual([]); // both skipped
    expect(await kickoffDependents(a.id)).toEqual([]); // double ship: still nothing
    expect(getFeature(armed.id)!.branch).toBe("feature/already"); // untouched
  });

  it("does nothing when the flag is off", async () => {
    process.env.ORCH_FEATURE_AUTOPILOT = "0";
    const { project, feature: a } = await armFixture();
    const b = createFeature({ project_id: project.id, name: `FB-${uid()}` });
    setFeatureDeps(b.id, [a.id]);
    updateFeature(a.id, { merged_at: Date.now() });
    expect(await kickoffDependents(a.id)).toEqual([]);
    expect(getFeature(b.id)!.autopilot).toBe(0);
  });

  it("orphan: deleting the predecessor leaves the dependent dormant", async () => {
    const { project, feature: a } = await armFixture();
    const b = createFeature({ project_id: project.id, name: `OR-${uid()}` });
    setFeatureDeps(b.id, [a.id]);
    deleteFeature(a.id); // cascade removes the edge; no ship event ever fires
    expect(getFeatureDeps(b.id)).toEqual([]);
    expect(getFeature(b.id)!.autopilot).toBe(0);
  });

  it("an edge created after its dep already shipped stays dormant", async () => {
    const { project, feature: a } = await armFixture();
    updateFeature(a.id, { merged_at: Date.now() }); // shipped before the edge existed
    const b = createFeature({ project_id: project.id, name: `LA-${uid()}` });
    setFeatureDeps(b.id, [a.id]); // must NOT arm as a side effect
    expect(getFeature(b.id)!.autopilot).toBe(0);
    expect(featureDepsSatisfied(b.id)).toBe(true); // informational edge — kickoff only fires on ship/heal
  });
});

describe("suggest_feature after:", () => {
  it("resolves names, auto-creates on miss, and wires deps", () => {
    const p = createProject({ name: `SF-${uid()}` });
    const a = createFeature({ project_id: p.id, name: "Alpha" });
    const { feature: b, text } = createSuggestedFeature(p, { name: "Beta", after: ["Alpha", "Gamma"] });
    const deps = getFeatureDeps(b.id);
    expect(deps).toContain(a.id);
    expect(deps).toHaveLength(2); // Gamma auto-created
    expect(text).toContain("Starts after");
  });

  it("a cycle degrades to a note, not a throw", () => {
    const p = createProject({ name: `SFC-${uid()}` });
    const a = createFeature({ project_id: p.id, name: "One" });
    const b = createFeature({ project_id: p.id, name: "Two" });
    setFeatureDeps(b.id, [a.id]);
    const { text } = createSuggestedFeature(p, { name: "One", after: ["Two"] });
    expect(text).toContain("dependency cycle");
    expect(getFeatureDeps(a.id)).toEqual([]); // unchanged
  });

  it("a bare upsert never wipes an existing chain", () => {
    const p = createProject({ name: `SFU-${uid()}` });
    const a = createFeature({ project_id: p.id, name: "Head" });
    const b = createFeature({ project_id: p.id, name: "Tail" });
    setFeatureDeps(b.id, [a.id]);
    createSuggestedFeature(p, { name: "Tail", description: "updated" }); // no `after`
    expect(getFeatureDeps(b.id)).toEqual([a.id]);
  });
});
