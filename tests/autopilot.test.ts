import { describe, it, expect } from "vitest";

import {
  createProject,
  createFeature,
  createTask,
  updateFeature,
  updateTask,
  listFeatures,
  getFeature,
  getTask,
  setTaskDeps,
  featureMembers,
  readyMembers,
} from "@/lib/store";

describe("autopilot schema", () => {
  it("defaults autopilot off and round-trips the new columns", () => {
    const p = createProject({ name: "S" });
    const f = createFeature({ project_id: p.id, name: "F" });
    expect(f.autopilot).toBe(0);
    expect(f.pr_url).toBe("");

    updateFeature(f.id, { autopilot: 1, pr_url: "https://example/pull/1" });
    expect(getFeature(f.id)).toMatchObject({ autopilot: 1, pr_url: "https://example/pull/1" });

    const t = createTask({ project_id: p.id, title: "T", feature_id: f.id });
    expect(t.gate_attempts).toBe(0);
    expect(t.blocked_reason).toBe("");
    updateTask(t.id, { gate_attempts: 2, blocked_reason: "gate failed twice" });
    expect(getTask(t.id)).toMatchObject({ gate_attempts: 2, blocked_reason: "gate failed twice" });
  });

  it("counts blocked members in listFeatures", () => {
    const p = createProject({ name: "S2" });
    const f = createFeature({ project_id: p.id, name: "F2" });
    const t = createTask({ project_id: p.id, title: "T", feature_id: f.id });
    expect(listFeatures(p.id).find((x) => x.id === f.id)!.blocked_count).toBe(0);
    updateTask(t.id, { blocked_reason: "stuck" });
    expect(listFeatures(p.id).find((x) => x.id === f.id)!.blocked_count).toBe(1);
  });
});

describe("readyMembers", () => {
  it("excludes suggested, running, blocked, terminal, and dep-blocked tasks", () => {
    const p = createProject({ name: "R" });
    const f = createFeature({ project_id: p.id, name: "RF" });
    const mk = (title: string, patch: Record<string, unknown> = {}) => {
      const t = createTask({ project_id: p.id, title, feature_id: f.id });
      if (Object.keys(patch).length) updateTask(t.id, patch);
      return t;
    };

    const ready = mk("ready");
    mk("suggested-one", { suggested: 1 });
    mk("running-one", { running: 1 });
    mk("blocked-one", { blocked_reason: "stuck" });
    mk("done-one", { status: "done" });
    mk("parked-one", { status: "on_hold" });
    const dep = mk("dep");
    const afterDep = mk("after-dep");
    setTaskDeps(afterDep.id, [dep.id]);

    expect(featureMembers(f.id)).toHaveLength(8);

    const ids = readyMembers(f.id).map((t) => t.id);
    expect(ids).toContain(ready.id);
    expect(ids).toContain(dep.id);
    expect(ids).not.toContain(afterDep.id);
    expect(ids).toHaveLength(2);

    // The dependency landing is what makes the dependent startable — the whole
    // point of the graph having a consumer.
    updateTask(dep.id, { status: "done" });
    expect(readyMembers(f.id).map((t) => t.id)).toContain(afterDep.id);
  });
});
