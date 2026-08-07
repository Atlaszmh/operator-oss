# Feature Chaining Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a feature ships, automatically give its dependent features the approve-plan treatment (branch cut, tasks accepted, autopilot armed) — so a multi-feature plan runs end to end off one approval.

**Architecture:** A `feature_dependencies` table mirroring `task_dependencies`; an idempotent `approvePlan()` helper extracted from the approve-plan route; `kickoffDependents()` called from both writers of `features.merged_at` (the ship route and `reconcileFeatureBranch`'s heal path). Agent tool `suggest_feature` gains `after:`; the feature page gains a dep picker; feature group headers gain an "after:" badge.

**Tech Stack:** Next.js 15 App Router, better-sqlite3 (schema in `lib/db.ts`, queries in `lib/store.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-feature-chaining-design.md` — the authority on all behavior decisions.

**Branch:** work on `feature/feature-chaining` cut from `main`.

---

## Chunk 1: Schema + store

### Task 1: `feature_dependencies` table

**Files:**
- Modify: `lib/db.ts` (after the `task_dependencies` block, ~line 241; indexes ~line 283)
- Modify: `lib/types.ts` (the `Feature` interface, ~line 40)

- [ ] **Step 1: Add the table + indexes**

In `lib/db.ts`, directly after the `task_dependencies` CREATE block (after line 241), add:

```sql
    -- Feature ordering: a feature "depends on" (starts after) another. Until
    -- every depends_on_id feature has SHIPPED (merged_at > 0), the dependent
    -- stays dormant; when the last one ships it automatically receives the
    -- approve-plan treatment (see lib/approvePlan.ts kickoffDependents). Both
    -- sides cascade-delete with their feature. CREATE IF NOT EXISTS means older
    -- DBs pick this up automatically — no migrate() entry needed.
    CREATE TABLE IF NOT EXISTS feature_dependencies (
      feature_id    TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (feature_id, depends_on_id)
    );
```

And with the other indexes (~line 283):

```sql
    CREATE INDEX IF NOT EXISTS idx_feature_deps_feature ON feature_dependencies(feature_id);
    CREATE INDEX IF NOT EXISTS idx_feature_deps_dep ON feature_dependencies(depends_on_id);
```

- [ ] **Step 2: Add `depends_on` to the Feature type**

In `lib/types.ts`, add to the `Feature` interface (after `sync_conflict`):

```ts
  // Feature ids this feature starts after (feature_dependencies). Populated by
  // listFeatures; absent on bare getFeature reads. NOTE: the task mirror keeps
  // depends_on on the store-level TaskWithUsage type instead — for features it
  // lives on the shared type deliberately.
  depends_on?: string[];
```

- [ ] **Step 3: Commit**

```bash
git add lib/db.ts lib/types.ts
git commit -m "feat: feature_dependencies table + Feature.depends_on type"
```

### Task 2: Store functions

**Files:**
- Modify: `lib/store.ts` (features section, after `setTaskDeps` patterns; `listFeatures` at ~line 318)
- Test: `tests/featureDeps.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/featureDeps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createProject,
  createFeature,
  updateFeature,
  listFeatures,
  getFeatureDeps,
  getFeatureDependents,
  setFeatureDeps,
  featureDepsSatisfied,
} from "@/lib/store";
import { uid } from "./helpers";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/featureDeps.test.ts`
Expected: FAIL — `getFeatureDeps` etc. are not exported from `@/lib/store`.

- [ ] **Step 3: Implement the store functions**

In `lib/store.ts`, after `setTaskDeps` (~line 616) add — mirroring the task versions exactly:

```ts
// ---------- feature dependencies (feature chaining) ----------

// The feature ids a given feature starts after.
export function getFeatureDeps(featureId: string): string[] {
  return (
    getDb().prepare("SELECT depends_on_id FROM feature_dependencies WHERE feature_id = ?").all(featureId) as {
      depends_on_id: string;
    }[]
  ).map((r) => r.depends_on_id);
}

// The reverse edge: features that start after `featureId` — kickoffDependents'
// worklist when it ships.
export function getFeatureDependents(featureId: string): string[] {
  return (
    getDb().prepare("SELECT feature_id FROM feature_dependencies WHERE depends_on_id = ?").all(featureId) as {
      feature_id: string;
    }[]
  ).map((r) => r.feature_id);
}

// Replace a feature's dependency set. Mirrors setTaskDeps: drops self-references
// and ids outside the feature's project, then guards against cycles. Throws on a
// cycle. Never arms anything — an edge whose deps are already all shipped is
// informational (kickoff fires only on a ship/heal event; see the spec).
export function setFeatureDeps(featureId: string, dependsOn: string[]): void {
  const db = getDb();
  const feature = getFeature(featureId);
  if (!feature) throw new Error("feature not found");
  const wanted = [...new Set(dependsOn)].filter((id) => id && id !== featureId);
  const valid = wanted.filter((id) => {
    const f = getFeature(id);
    return !!f && f.project_id === feature.project_id;
  });
  const edges = db.prepare("SELECT feature_id, depends_on_id FROM feature_dependencies").all() as {
    feature_id: string;
    depends_on_id: string;
  }[];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.feature_id === featureId) continue; // replacing featureId's edges with `valid`
    const list = adj.get(e.feature_id);
    if (list) list.push(e.depends_on_id);
    else adj.set(e.feature_id, [e.depends_on_id]);
  }
  adj.set(featureId, valid);
  const seen = new Set<string>();
  const stack = [...valid];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === featureId) throw new Error("dependency cycle");
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) stack.push(n);
  }
  const now = Date.now();
  db.transaction(() => {
    db.prepare("DELETE FROM feature_dependencies WHERE feature_id = ?").run(featureId);
    const ins = db.prepare("INSERT INTO feature_dependencies (feature_id, depends_on_id, created_at) VALUES (?, ?, ?)");
    for (const id of valid) ins.run(featureId, id, now);
  })();
}

// True when nothing this feature depends on is still unshipped. Satisfied =
// merged_at > 0 — SHIPPED, not "tasks done" and not "archived": an abandoned
// predecessor (archived without merging) stalls the chain rather than silently
// starting work on a base that never got the prerequisite. Manual approve-plan
// is the escape hatch.
export function featureDepsSatisfied(featureId: string): boolean {
  return getFeatureDeps(featureId).every((id) => {
    const f = getFeature(id);
    return !!f && f.merged_at > 0;
  });
}
```

Then in `listFeatures()` (~line 318), attach the edges the same way `listTasks` does. After the `rows` query, before the `return`:

```ts
  // Attach each feature's dependency edges in one query (project-scoped via join).
  const edges = getDb()
    .prepare(
      `SELECT fd.feature_id, fd.depends_on_id FROM feature_dependencies fd
       JOIN features f ON f.id = fd.feature_id WHERE f.project_id = ?`
    )
    .all(projectId) as { feature_id: string; depends_on_id: string }[];
  const depsByFeature = new Map<string, string[]>();
  for (const e of edges) {
    const list = depsByFeature.get(e.feature_id);
    if (list) list.push(e.depends_on_id);
    else depsByFeature.set(e.feature_id, [e.depends_on_id]);
  }
  const pkey = projectKeyOf(projectId);
  return rows.map((r) => ({ ...r, key: displayKey(pkey, r.seq, "F"), depends_on: depsByFeature.get(r.id) ?? [] }));
```

(Replaces the existing `const pkey` + `return rows.map(...)` lines.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/featureDeps.test.ts`
Expected: PASS (all).
Also run the neighbors: `npx vitest run tests/features.test.ts tests/autopilot.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts tests/featureDeps.test.ts
git commit -m "feat: feature dependency store — setFeatureDeps, featureDepsSatisfied, listFeatures join"
```

## Chunk 2: approvePlan extraction + kickoff on ship/heal

### Task 3: `lib/approvePlan.ts`

**Files:**
- Create: `lib/approvePlan.ts`
- Modify: `app/api/features/[id]/approve-plan/route.ts` (becomes a thin wrapper)
- Test: `tests/featureDeps.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/featureDeps.test.ts`:

```ts
import { approvePlan, kickoffDependents } from "@/lib/approvePlan";
import { createTask, deleteFeature, getFeature, getTask, updateProject } from "@/lib/store";
import { makeRepo } from "./helpers";
import { beforeEach, afterEach, vi } from "vitest";

// approvePlan arms the controller and kicks a detached sweep — real scheduling
// that would spawn actual agent turns from a unit test (driveFeature step 2 →
// startInitialTurn → the real driver). Mock the two entry points; the
// controller's own wiring is pinned by tests/autopilotRun.test.ts.
vi.mock("@/lib/autopilot", () => ({ ensureAutopilot: vi.fn(), sweep: vi.fn().mockResolvedValue(undefined) }));

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/featureDeps.test.ts`
Expected: FAIL — `@/lib/approvePlan` does not exist.

- [ ] **Step 3: Create `lib/approvePlan.ts`**

```ts
// Gate 1 as a callable: the approve-plan treatment (cut the integration branch,
// accept the plan's suggestions, arm autopilot), extracted from the route so
// feature chaining can apply it without an HTTP request. Two callers:
//   - POST /api/features/[id]/approve-plan (the button)
//   - kickoffDependents() below, fired from both writers of features.merged_at
//     (the ship route, and reconcileFeatureBranch's lost-stamp heal)
import { getFeature, getProject, updateFeature, updateTask, featureMembers, getFeatureDependents, featureDepsSatisfied } from "./store";
import { createFeatureBranch } from "./git";
import { ensureAutopilot, sweep } from "./autopilot";
import { resolveFeatures } from "./features";
import { track } from "./analytics";
import type { Feature, Project } from "./types";

// Slugify a feature name into a branch-safe segment. Falls back to the id when a
// name is all punctuation, because "feature/" is not a branch.
const branchNameFor = (name: string, id: string) =>
  `feature/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || id}`;

export type ApprovePlanResult =
  | { ok: true; outcome: "did-work" | "already-armed"; branch: string; accepted: number; total: number }
  | { ok: false; outcome: "flag-off" | "no-repo" | "branch-failed"; error: string };

/**
 * Everything this does, the user could do by hand: accept each suggestion, cut
 * the integration branch, start the first task. Idempotency: already armed ⇒
 * skip entirely; a pre-existing branch (cut via POST /branch) ⇒ skip only the
 * cut and still accept + arm. The flag check lives HERE, not in the route, so
 * chain kickoff can never arm features on an instance whose operator disabled
 * autopilot.
 */
export async function approvePlan(feature: Feature, project: Project): Promise<ApprovePlanResult> {
  if (!resolveFeatures().autopilot)
    return { ok: false, outcome: "flag-off", error: "Autopilot is not enabled on this instance (set ORCH_FEATURE_AUTOPILOT=1)." };
  if (!project.repo_path)
    return { ok: false, outcome: "no-repo", error: "this project has no working directory" };
  // Skip-entirely on armed also skips the ensureAutopilot()/sweep() re-kick the
  // old route performed on a re-click. Deliberate: the always-open /api/events
  // subscription and the safety sweep both re-arm the controller, and a chain
  // kickoff must not re-drive a feature that's already running.
  if (feature.autopilot)
    return { ok: true, outcome: "already-armed", branch: feature.branch, accepted: 0, total: featureMembers(feature.id).length };

  // An empty feature is allowed: arming BEFORE the plan exists is the kickoff
  // flow (see driveFeature step 0).
  const members = featureMembers(feature.id);

  // Cut the integration branch if the feature hasn't got one. Not optional: an
  // empty features.branch means member tasks merge straight onto the project
  // branch, which is exactly what the second gate exists to prevent.
  let branch = feature.branch;
  if (!branch) {
    branch = branchNameFor(feature.name, feature.id);
    const made = await createFeatureBranch(project.repo_path, branch, project.branch);
    if (!made)
      return {
        ok: false,
        outcome: "branch-failed",
        error: "could not create the integration branch — is the working directory a git repo with at least one commit?",
      };
    updateFeature(feature.id, { branch, base_sha: made.sha });
  }

  // Accept the plan: every suggestion becomes committed work. A member the user
  // already accepted (or cancelled) is left exactly as it is.
  let accepted = 0;
  for (const t of members) {
    if (!t.suggested) continue;
    updateTask(t.id, { suggested: 0 });
    accepted++;
  }
  updateFeature(feature.id, { autopilot: 1 });
  track("autopilot_plan_approved", { feature_id: feature.id, project_id: project.id, tasks: members.length, accepted });

  // Arm the controller and kick the first pass. Detached — a caller must never
  // own multi-minute work.
  ensureAutopilot();
  void sweep(project.id).catch(() => {});

  return { ok: true, outcome: "did-work", branch, accepted, total: members.length };
}

export interface KickoffResult {
  featureId: string;
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * The chain: `featureId` just shipped — give every dependent whose deps have ALL
 * now shipped the approve-plan treatment. The dependency edge is the approval
 * marker (see the spec): it only exists because the planner or user deliberately
 * chained, and approving the head approved the chain. Never throws; per-
 * dependent failures are returned, a flag-off no-op is just logged.
 */
export async function kickoffDependents(featureId: string): Promise<KickoffResult[]> {
  const results: KickoffResult[] = [];
  for (const depId of getFeatureDependents(featureId)) {
    const f = getFeature(depId);
    if (!f || f.archived || f.autopilot) continue;
    if (!featureDepsSatisfied(f.id)) continue;
    const project = getProject(f.project_id);
    if (!project) continue;
    try {
      const res = await approvePlan(f, project);
      if (res.ok) results.push({ featureId: f.id, name: f.name, ok: true });
      else if (res.outcome === "flag-off") console.log(`[chain] not kicking off "${f.name}": autopilot is not enabled on this instance`);
      else results.push({ featureId: f.id, name: f.name, ok: false, error: res.error });
    } catch (e) {
      results.push({ featureId: f.id, name: f.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
```

- [ ] **Step 4: Thin the approve-plan route**

Replace the body of `app/api/features/[id]/approve-plan/route.ts` with:

```ts
import { NextResponse } from "next/server";
import { getFeature, getProject } from "@/lib/store";
import { approvePlan } from "@/lib/approvePlan";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Gate 1 — the user approves the plan. The work lives in lib/approvePlan.ts so
// feature chaining can apply the same treatment without an HTTP request; this
// wrapper only maps the outcome onto HTTP. flag-off stays a 400 here (the
// button must say why it did nothing) while chain kickoff just logs it.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });

  const res = await approvePlan(feature, project);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, branch: res.branch, accepted: res.accepted, total: res.total });
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/featureDeps.test.ts tests/autopilot.test.ts tests/autopilotRun.test.ts tests/features.test.ts`
Expected: PASS. (If an approve-plan route test exists and asserts the flag-off 400, it still passes — the message is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add lib/approvePlan.ts app/api/features/[id]/approve-plan/route.ts tests/featureDeps.test.ts
git commit -m "feat: extract approvePlan() + kickoffDependents() for feature chaining"
```

### Task 4: Kickoff call sites (ship + heal)

**Files:**
- Modify: `app/api/features/[id]/ship/route.ts` (~line 108–147)
- Modify: `lib/featureSync.ts` (`reconcileFeatureBranch`, ~line 370)

- [ ] **Step 1: Ship route**

In `app/api/features/[id]/ship/route.ts`, import `kickoffDependents` and the result type:

```ts
import { kickoffDependents, type KickoffResult } from "@/lib/approvePlan";
```

After the sync step (the `const syncNote = summarizeSync(synced);` line, ~line 122), add:

```ts
        // Feature chaining: this landing may be what a dependent was waiting
        // for. Cut its branch NOW — from a base that already contains this
        // feature's work — and arm it. One announced line per kicked-off
        // dependent so the chain is visible in the ship log; a failure is that
        // dependent's problem, never the ship's.
        let chained: KickoffResult[] = [];
        if (!res.alreadyMerged) {
          chained = await kickoffDependents(feature.id);
          for (const k of chained) {
            send({ type: "step", key: `chain-${k.featureId}`, label: k.ok ? `Kicked off ${k.name}` : `Couldn't kick off ${k.name}: ${k.error}` });
            send({ type: "step_done", key: `chain-${k.featureId}`, ms: 0 });
          }
        }
```

Then extend the final result `text` (the `Shipped ${feature.name}...` template) with a chain note. Change the `send({ type: "result", ok: true, ... })` block to include:

```ts
        const chainNote = chained.filter((k) => k.ok).length
          ? ` Kicked off ${chained.filter((k) => k.ok).map((k) => k.name).join(", ")}.`
          : "";
```

(declared just above the `send`), add `chained,` as a field next to `synced,`, and append `${chainNote}` to the non-alreadyMerged text branch at the very end — after `${published.note ? ` ${published.note}` : ""}`.

- [ ] **Step 2: Heal path**

In `lib/featureSync.ts` `reconcileFeatureBranch`, the lost-stamp heal (~line 370) currently reads:

```ts
      updateFeature(f.id, { merged_at: Date.now(), sync_conflict: "" });
      return;
```

Change to:

```ts
      updateFeature(f.id, { merged_at: Date.now(), sync_conflict: "" });
      // The stamp IS the ship event for chaining purposes — without this, a
      // healed predecessor stalls its chain silently while the UI shows every
      // dep shipped. Dynamic import: featureSync ← autopilot ← (this heal) would
      // otherwise be a static cycle. Never throws (kickoffDependents guarantees
      // it), and the enclosing try swallows a failed import with the rest.
      const { kickoffDependents } = await import("./approvePlan");
      await kickoffDependents(f.id);
      return;
```

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS across the board (ship/gate/sync tests unchanged in behavior — kickoff on a feature with no dependents is a no-row query).

- [ ] **Step 4: Commit**

```bash
git add app/api/features/[id]/ship/route.ts lib/featureSync.ts
git commit -m "feat: kick off dependent features from both merged_at writers (ship + heal)"
```

## Chunk 3: Agent tool, API, UI

### Task 5: `after:` on suggest_feature

**Files:**
- Modify: `lib/agentToolDefs.mjs` (SUGGEST_FEATURE, ~line 43)
- Modify: `lib/agentTools.ts` (`createSuggestedFeature`, ~line 143)
- Modify: `lib/agents/claude/driver.ts` (suggest_feature tool, ~line 106)
- Modify: `scripts/orch-mcp.mjs` (suggest_feature registration, ~line 106)
- Modify: `app/api/internal/agent-tools/suggest-feature/route.ts`
- Test: `tests/featureDeps.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/featureDeps.test.ts`:

```ts
import { createSuggestedFeature } from "@/lib/agentTools";

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
});
```

(`createProject` returns a full `Project`, so no cast is needed.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/featureDeps.test.ts`
Expected: FAIL — `after` is not accepted / no dep written.

- [ ] **Step 3: Implement**

`lib/agentToolDefs.mjs` — add to `SUGGEST_FEATURE.params`:

```js
    after:
      "Names (or ids) of features that must SHIP before this one starts. When the last of them ships, this feature's " +
      "plan is automatically approved and started (branch cut, tasks accepted, autopilot on) — so a multi-feature plan " +
      "runs end to end off one approval. Unknown names create the feature. Omit for a feature that starts on its own.",
```

And extend the description's final sentence list with: `"To CHAIN features (build B after A ships), pass after: [\"A\"] on B."` (append to the existing description string).

`lib/agentTools.ts` — `createSuggestedFeature` gains `after?: string[]` on its input and wires deps in both the update and create paths. Replace the function's input type and add a helper at the end of the function body. New shape:

```ts
export function createSuggestedFeature(
  project: Project,
  input: { name: string; description?: string; context?: string; after?: string[] }
): { feature: Feature; text: string } {
```

and, just before each `return`, resolve + attach (factor once above the `existing` check):

```ts
  // Resolve `after:` refs the way task blocked_by resolves features: by id/key/
  // name, auto-creating on a miss (a planner files "after: M1" before M1's own
  // suggest_feature call often enough that rejecting would break real plans).
  // Only applied when the field is present — a bare re-reference must not wipe
  // an existing chain, same rule as description/context.
  const wireAfter = (featureId: string): string => {
    if (input.after === undefined) return "";
    const ids = input.after
      .map((ref) => ref.trim())
      .filter(Boolean)
      .map((ref) => findFeature(project.id, ref)?.id ?? createFeature({ project_id: project.id, name: ref }).id);
    try {
      setFeatureDeps(featureId, ids);
      return ids.length ? ` Starts after ${ids.length} feature(s) — it will be approved and started automatically when they have all shipped.` : "";
    } catch (e) {
      return ` (Could not set the feature chain: ${(e as Error).message}.)`;
    }
  };
```

Then in the `existing` branch, change the return to append the note from `wireAfter(feature.id)`:

```ts
    const afterNote = wireAfter(feature.id);
    return {
      feature,
      text:
        `Updated the existing feature "${feature.name}" (id: ${feature.id}). ` +
        `Pass feature: "${feature.name}" on suggest_task to file work into it.` +
        afterNote,
    };
```

and in the create branch likewise:

```ts
  const afterNote = wireAfter(feature.id);
  return {
    feature,
    text:
      `Created the feature "${feature.name}" (id: ${feature.id}). ` +
      `Pass feature: "${feature.name}" on each suggest_task that belongs to it — its context is prepended to every one of their sessions.` +
      afterNote,
  };
```

Add `setFeatureDeps` to the `./store` import list.

`lib/agents/claude/driver.ts` — in the suggest_feature tool (~line 109), add to the zod schema:

```ts
          after: z.array(z.string()).optional().describe(SUGGEST_FEATURE.params.after),
```

and widen the handler args type to `{ name: string; description?: string; context?: string; after?: string[] }` (the existing `createSuggestedFeature(project, args)` pass-through then carries it).

`scripts/orch-mcp.mjs` — mirror in the bridge (~line 110):

```js
      after: z.array(z.string()).optional().describe(SUGGEST_FEATURE.params.after),
```

and pass it through: `async ({ name, description, context, after }) => { const data = await callInternal("suggest-feature", { name, description, context, after }); ... }`.

`app/api/internal/agent-tools/suggest-feature/route.ts` — accept and forward:

```ts
  let body: { projectId?: string; name?: string; description?: string; context?: string; after?: string[] };
```

and in the `createSuggestedFeature` call:

```ts
    after: Array.isArray(body.after) ? body.after.filter((x): x is string => typeof x === "string") : undefined,
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/featureDeps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agentToolDefs.mjs lib/agentTools.ts lib/agents/claude/driver.ts scripts/orch-mcp.mjs app/api/internal/agent-tools/suggest-feature/route.ts tests/featureDeps.test.ts
git commit -m "feat: suggest_feature after: — planners can chain features"
```

### Task 6: PATCH depends_on + UI

**Files:**
- Modify: `app/api/features/[id]/route.ts` (PATCH)
- Modify: `app/orchestrator/types.ts` (FeatureRow)
- Modify: `app/orchestrator/useOrchestrator.ts` (`saveFeature`, ~line 434)
- Modify: `app/orchestrator/FeatureLanding.tsx` (dep picker in edit mode + "starts after" line)
- Modify: `app/Orchestrator.tsx` (~line 247 — pass `features` to FeatureLanding)
- Modify: `app/orchestrator/TasksColumn.tsx` (`FeatureGroupHeader` badge)

- [ ] **Step 1: PATCH route**

In `app/api/features/[id]/route.ts`, import `setFeatureDeps` from `@/lib/store`, and after the `name` handling (before `updateFeature`):

```ts
  // The chain edges. Not a column, so handled beside the whitelist: replace-set
  // semantics, same guards as tasks (self/cross-project dropped, cycles 400).
  // Setting deps never arms anything — kickoff fires only on a ship/heal event.
  if ("depends_on" in body) {
    if (!Array.isArray(body.depends_on)) return NextResponse.json({ error: "depends_on must be an array of feature ids" }, { status: 400 });
    try {
      setFeatureDeps(id, body.depends_on.filter((x: unknown): x is string => typeof x === "string"));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
```

- [ ] **Step 2: Client type + saveFeature**

`app/orchestrator/types.ts` — add to `FeatureRow` (after `sync_conflict`):

```ts
  // Feature ids this one starts after. When the last of them ships, this
  // feature is auto-approved and started (lib/approvePlan.ts).
  depends_on: string[];
```

`app/orchestrator/useOrchestrator.ts` (~line 434) — widen the pick:

```ts
  const saveFeature = async (id: string, patch: Partial<Pick<FeatureRow, "name" | "description" | "context" | "archived" | "depends_on">> & { force?: boolean }) => {
```

- [ ] **Step 3: FeatureLanding — picker + display**

`app/Orchestrator.tsx` (~line 252) — pass the full feature list:

```tsx
            features={o.features}
```

`app/orchestrator/FeatureLanding.tsx`:
- Add `features: FeatureRow[];` to the props (and destructure it).
- Widen `onSave`'s patch type with `"depends_on"` in the `Pick`.
- Add state seeded like the others: `const [deps, setDeps] = useState<string[]>(feature.depends_on ?? []);` and reseed it in a SECOND effect keyed on the stringified value (arrays get a fresh identity on every rollup fetch, so putting the array itself in the dep list would stomp an in-progress edit on every refresh):

```tsx
  // Reseed the chain draft only when it actually changed server-side.
  const depsKey = JSON.stringify(feature.depends_on ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depsKey stands in for feature.depends_on
  useEffect(() => { setDeps(feature.depends_on ?? []); }, [feature.id, depsKey]);
```
- Include it in save: `await onSave(feature.id, { name: name.trim(), description, context, depends_on: deps });`
- Candidates: `const chainCandidates = features.filter((f) => f.id !== feature.id && !f.archived);`
- In the edit-mode body (below the context textarea's edit branch), add a section:

```tsx
          {editing && (
            <div className="feat-sect">
              <div className="feat-sect-h">
                Starts after
                <span className="feat-hint">When the last of these ships, this feature&apos;s plan is approved and started automatically.</span>
              </div>
              {chainCandidates.length === 0 ? (
                <div className="hlp">No other features in this project yet.</div>
              ) : (
                <div className="dep-list">
                  {chainCandidates.map((c) => (
                    <label key={c.id} className={`dep-row ${deps.includes(c.id) ? "on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={deps.includes(c.id)}
                        onChange={() => setDeps((d) => (d.includes(c.id) ? d.filter((x) => x !== c.id) : [...d, c.id]))}
                      />
                      <span className="dep-title">{c.name}</span>
                      <span className="dep-status">{c.merged_at > 0 ? "Shipped" : ""}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
```

- In view mode, next to the progress stats (`feat-stats` block), when the feature has unshipped deps, show the queue line:

```tsx
            {!editing && (feature.depends_on ?? []).length > 0 && (() => {
              const waiting = (feature.depends_on ?? [])
                .map((id) => features.find((f) => f.id === id))
                .filter((f): f is FeatureRow => !!f && f.merged_at === 0);
              return waiting.length ? (
                <span className="feat-stat" title="Approved and started automatically when these ship">
                  after: {waiting.map((f) => f.name).join(", ")}
                </span>
              ) : null;
            })()}
```

- [ ] **Step 4: Group header badge**

`app/orchestrator/TasksColumn.tsx`:
- `FeatureGroup` and `FeatureGroupHeader` both gain an optional `afterNames?: string[]` prop, passed straight through.
- In `FeatureGroupHeader`, next to the `sync_conflict` chip (~line 146), add:

```tsx
      {afterNames && afterNames.length > 0 && (
        <span className="fgh-sug" title={`Starts automatically after ${afterNames.join(", ")} ship${afterNames.length === 1 ? "s" : ""}`}>
          after: {afterNames.join(", ")}
        </span>
      )}
```

(reusing the existing `fgh-sug` chip styling — no new CSS.)
- At the `FeatureGroup` call sites (search for `<FeatureGroup` in the same file — both the active and archived sections), compute from the `features` array already in scope:

```tsx
  const featureNameById = new Map(features.map((f) => [f.id, f.name]));
  const afterNamesFor = (f: FeatureRow) =>
    (f.depends_on ?? [])
      .filter((id) => {
        const dep = features.find((x) => x.id === id);
        return !!dep && dep.merged_at === 0;
      })
      .map((id) => featureNameById.get(id)!)
```

(place beside the existing `featureIds` computation) and pass `afterNames={afterNamesFor(f)}`.

- [ ] **Step 5: Build + full suite**

Run: `npx vitest run` — Expected: PASS.
Run: `npx next build` (or the repo's build script from package.json) — Expected: compiles clean, type errors none.

- [ ] **Step 6: Commit**

```bash
git add app/api/features/[id]/route.ts app/orchestrator/types.ts app/orchestrator/useOrchestrator.ts app/orchestrator/FeatureLanding.tsx app/Orchestrator.tsx app/orchestrator/TasksColumn.tsx
git commit -m "feat: feature chain editing (PATCH depends_on) + after: badges in the UI"
```

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (if it documents the feature layer — one line on chaining)
- Modify: `.env.example` — no new flags, skip unless a features doc exists.

- [ ] **Step 1:** Grep `CLAUDE.md` for the feature/autopilot section; add one line: chaining = `feature_dependencies` + `lib/approvePlan.ts`, kickoff fires from ship + heal. Skip if no such section exists.
- [ ] **Step 2:** Commit if changed.

---

## Verification (whole plan)

- [ ] `npx vitest run` — full suite green.
- [ ] Build passes.
- [ ] Manual sanity path (optional, needs `ORCH_FEATURE_AUTOPILOT=1`): create features A→B with a dep, approve A, ship A (or stamp `merged_at` via ship), observe B armed with a fresh branch.
