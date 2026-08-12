import { describe, it, expect } from "vitest";
import { featureState, isFinished, isGating, FEATURE_STATE_LABEL } from "@/app/orchestrator/format";
import type { FeatureRow, TaskRow } from "@/app/orchestrator/types";

// Only the fields featureState reads; the rest of FeatureRow is irrelevant here.
const f = (over: Partial<FeatureRow>): FeatureRow =>
  ({
    merged_at: 0, branch: "", pr_url: "",
    total: 0, done: 0, merged_count: 0, running_count: 0, awaiting_count: 0, blocked_count: 0,
    ...over,
  }) as FeatureRow;

// The client-side mirror of isSettledForGating() in lib/autopilot.ts. A wrong
// "Reviewing" is worse than none — it would tell the user the machine has their
// work when nothing has it — so every way OUT of the state is pinned here.
describe("isGating", () => {
  const t = (over: Partial<TaskRow>): TaskRow =>
    ({
      status: "in_progress", started: 1, running: 0, suggested: 0, awaiting_input: 0, blocked_reason: "",
      ...over,
    }) as TaskRow;

  it("is true for a settled member of an armed feature", () => {
    expect(isGating(t({}), true)).toBe(true);
  });

  it("is false when the feature is not running unattended", () => {
    // The whole precondition: only autopilot gates. A hand-driven task that
    // ends its turn raises awaiting_input and reads "Needs your input".
    expect(isGating(t({}), false)).toBe(false);
  });

  it("is false while the agent still has it", () => {
    expect(isGating(t({ running: 1 }), true)).toBe(false);
    // The live set the card holds can be fresher than the row it was given.
    expect(isGating(t({ running: 0 }), true, true)).toBe(false);
  });

  it("is false for anything actually waiting on the user", () => {
    expect(isGating(t({ awaiting_input: 1 }), true)).toBe(false);
    expect(isGating(t({ blocked_reason: "the gate failed 3 times" }), true)).toBe(false);
  });

  it("is false for work that hasn't started or isn't accepted yet", () => {
    expect(isGating(t({ started: 0, status: "not_started" }), true)).toBe(false);
    expect(isGating(t({ suggested: 1 }), true)).toBe(false);
  });

  it("is false once the task is finished or parked by hand", () => {
    for (const status of ["done", "cancelled", "on_hold"] as const)
      expect(isGating(t({ status }), true)).toBe(false);
  });
});

describe("featureState", () => {
  it("is shipped once the integration branch has landed", () => {
    expect(featureState(f({ branch: "feat/x", merged_at: 1, total: 3, done: 3 }))).toBe("shipped");
  });

  it("is shipped with no branch when every member is done and merged", () => {
    // The common case: an integration branch is opt-in, so most features never
    // get a merged_at and would otherwise never earn the badge.
    expect(featureState(f({ total: 3, done: 3, merged_count: 3 }))).toBe("shipped");
  });

  it("is only done when the members are finished but not all merged", () => {
    expect(featureState(f({ total: 3, done: 3, merged_count: 1 }))).toBe("done");
  });

  it("is done, not shipped, in a project where nothing can merge", () => {
    // No working directory means merged_at can never be set on anything. The
    // feature is finished, but claiming it shipped would be a lie.
    expect(featureState(f({ total: 2, done: 2, merged_count: 0 }))).toBe("done");
  });

  it("does not let a branched feature take the no-branch shortcut", () => {
    // Members merged INTO the integration branch is not the same as the
    // integration branch landing on the project branch.
    expect(featureState(f({ branch: "feat/x", total: 2, done: 2, merged_count: 2 }))).toBe("done");
  });

  it("prefers shipped over in review", () => {
    expect(featureState(f({ branch: "feat/x", merged_at: 1, pr_url: "http://pr" }))).toBe("shipped");
  });

  it("is in review while a PR is open", () => {
    expect(featureState(f({ branch: "feat/x", pr_url: "http://pr", total: 2, done: 2 }))).toBe("in_review");
  });

  it("is building once anything has moved", () => {
    expect(featureState(f({ total: 3, running_count: 1 }))).toBe("building");
    expect(featureState(f({ total: 3, done: 1 }))).toBe("building");
    expect(featureState(f({ total: 3, awaiting_count: 1 }))).toBe("building");
    expect(featureState(f({ total: 3, blocked_count: 1 }))).toBe("building");
  });

  it("is planned when nothing has moved, and when it is empty", () => {
    expect(featureState(f({ total: 3 }))).toBe("planned");
    expect(featureState(f({}))).toBe("planned");
    // An empty feature must not read as "done" off a 0 === 0 progress ratio.
    expect(featureState(f({ total: 0, done: 0, merged_count: 0 }))).toBe("planned");
  });

  it("labels only the states worth a pill", () => {
    expect(FEATURE_STATE_LABEL.building).toBe("");
    expect(FEATURE_STATE_LABEL.planned).toBe("");
    expect(FEATURE_STATE_LABEL.shipped).toBe("Shipped");
  });

  it("treats shipped and done as finished", () => {
    expect(isFinished("shipped")).toBe(true);
    expect(isFinished("done")).toBe(true);
    expect(isFinished("in_review")).toBe(false);
    expect(isFinished("building")).toBe(false);
  });
});
