import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit-level autopilot: the schema, the scheduler's queries, the verdict parser,
// and the gate. The gate's REVIEWER is scripted — it's an LLM turn, and what
// these pin is the gate's wiring (what runs, in what order, what a failure
// produces), not the reviewer's judgement. The controller that drives all of
// this lives in tests/autopilotRun.test.ts, which has to mock lib/gates and so
// can't also be the file that tests it.
const { reviewMock } = vi.hoisted(() => ({ reviewMock: vi.fn() }));
vi.mock("@/lib/agents/oneshots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/oneshots")>()),
  reviewTask: (prompt: string, cwd: string) => reviewMock(prompt, cwd),
}));

import fs from "node:fs";
import { runGate } from "@/lib/gates";
import { parseVerdict } from "@/lib/agents/shared";
import { buildFeaturePrBody } from "@/lib/github";
import { ensureWorktree } from "@/lib/git";
import { makeRepo } from "./helpers";
import {
  createProject,
  createFeature,
  createTask,
  updateFeature,
  updateTask,
  updateProject,
  listFeatures,
  getFeature,
  getTask,
  setTaskDeps,
  featureMembers,
  readyMembers,
} from "@/lib/store";

beforeEach(() => {
  reviewMock.mockReset();
  reviewMock.mockResolvedValue("Looks right.\nVERDICT: PASS");
});

/** A project on a real git repo, with a feature and one started task holding a worktree. */
async function gateFixture(patch: { test_command?: string } = {}) {
  const repo = await makeRepo();
  const project = updateProject(createProject({ name: `G-${Math.random().toString(36).slice(2, 8)}` }).id, {
    repo_path: repo,
    branch: "main",
    test_command: patch.test_command ?? "",
  })!;
  const feature = createFeature({ project_id: project.id, name: `GF-${Math.random().toString(36).slice(2, 8)}` });
  const task = createTask({ project_id: project.id, title: "Do the thing", feature_id: feature.id });
  const wt = await ensureWorktree(repo, task.id);
  const withWt = updateTask(task.id, {
    started: 1,
    status: "in_progress",
    awaiting_input: 1,
    worktree_path: wt?.path ?? "",
    work_branch: wt?.branch ?? "",
    base_sha: wt?.baseSha ?? "",
  })!;
  return { project, feature, task: withWt };
}

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
    // point of the graph finally having a consumer.
    updateTask(dep.id, { status: "done" });
    expect(readyMembers(f.id).map((t) => t.id)).toContain(afterDep.id);
  });

  // The deadlock that made "Approve plan & start" look like a dead button: a
  // plan split into chunks has its first task blocked_by the last task of the
  // previous feature, which is legal (setTaskDeps only refuses edges leaving the
  // PROJECT) and was permanently unsatisfiable, so nothing in the feature ever
  // became ready and autopilot started nothing at all.
  it("counts a dependency in another feature that is already done", () => {
    const p = createProject({ name: "X" });
    const prev = createFeature({ project_id: p.id, name: "chunk 1" });
    const next = createFeature({ project_id: p.id, name: "chunk 2" });

    const lastOfPrev = createTask({ project_id: p.id, title: "A7", feature_id: prev.id });
    updateTask(lastOfPrev.id, { status: "done" });
    const firstOfNext = createTask({ project_id: p.id, title: "B1", feature_id: next.id });
    setTaskDeps(firstOfNext.id, [lastOfPrev.id]);

    expect(readyMembers(next.id).map((t) => t.id)).toContain(firstOfNext.id);
  });

  // A dependency that can never complete must not park the queue forever.
  it("counts a cancelled dependency as satisfied", () => {
    const p = createProject({ name: "Y" });
    const f = createFeature({ project_id: p.id, name: "YF" });
    const cancelled = createTask({ project_id: p.id, title: "cancelled", feature_id: f.id });
    updateTask(cancelled.id, { status: "cancelled" });
    const afterCancelled = createTask({ project_id: p.id, title: "after", feature_id: f.id });
    setTaskDeps(afterCancelled.id, [cancelled.id]);

    expect(readyMembers(f.id).map((t) => t.id)).toContain(afterCancelled.id);
  });
});

describe("parseVerdict", () => {
  it("reads a verdict through the markdown a model reaches for", () => {
    expect(parseVerdict("looks fine\nVERDICT: PASS").ok).toBe(true);
    expect(parseVerdict("**VERDICT:** FAIL\n").ok).toBe(false);
    expect(parseVerdict("> verdict: pass").ok).toBe(true);
  });

  it("fails closed when there is no parseable verdict", () => {
    // An unparseable review must never become an automatic merge.
    expect(parseVerdict("I had a lot of thoughts but never concluded").ok).toBe(false);
    expect(parseVerdict("").ok).toBe(false);
  });

  it("returns the reasoning above the marker verbatim, as the next turn's instructions", () => {
    const v = parseVerdict("The migration is missing.\nAlso the test is skipped.\nVERDICT: FAIL");
    expect(v.notes).toBe("The migration is missing.\nAlso the test is skipped.");
  });
});

describe("runGate", () => {
  it("fails on a red suite and never spends a review turn on it", async () => {
    const { project, feature, task } = await gateFixture({ test_command: "exit 1" });
    const v = await runGate(task, project, feature);
    expect(v.ok).toBe(false);
    expect(v.testsRan).toBe(true);
    expect(v.reviewRan).toBe(false);
    expect(v.feedback).toMatch(/failed in your worktree/i);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it("runs the tests in the task's worktree, not the project repo", async () => {
    // The marker file exists only in the worktree, so a command that requires it
    // passes there and would fail in the shared checkout.
    const { project, feature, task } = await gateFixture({ test_command: "test -f only-here.txt" });
    fs.writeFileSync(`${task.worktree_path}/only-here.txt`, "x");
    const v = await runGate(task, project, feature);
    expect(v.testsRan).toBe(true);
    expect(v.ok).toBe(true);
  });

  it("tells the reviewer when there is no test command instead of implying the change was proven", async () => {
    const { project, feature, task } = await gateFixture({ test_command: "" });
    const v = await runGate(task, project, feature);
    expect(v.testsRan).toBe(false);
    expect(v.reviewRan).toBe(true);
    expect(reviewMock.mock.calls[0][0]).toMatch(/no test command/i);
  });

  it("passes the feature spec and the task brief to the reviewer, and runs it in the worktree", async () => {
    const { project, feature, task } = await gateFixture();
    updateFeature(feature.id, { context: "SPEC-SENTINEL" });
    await runGate(task, { ...project, context: "PROJECT-SENTINEL" }, getFeature(feature.id));
    const [prompt, cwd] = reviewMock.mock.calls[0];
    expect(prompt).toContain("SPEC-SENTINEL");
    expect(prompt).toContain("PROJECT-SENTINEL");
    expect(prompt).toContain("Do the thing");
    expect(cwd).toBe(task.worktree_path);
  });

  it("turns a failing review into instructions, not a report", async () => {
    reviewMock.mockResolvedValue("You left a TODO in the handler.\nVERDICT: FAIL");
    const { project, feature, task } = await gateFixture();
    const v = await runGate(task, project, feature);
    expect(v.ok).toBe(false);
    expect(v.feedback).toContain("You left a TODO in the handler.");
  });

  it("fails closed when the reviewer itself cannot run", async () => {
    reviewMock.mockRejectedValue(new Error("No coding agent is connected."));
    const { project, feature, task } = await gateFixture();
    const v = await runGate(task, project, feature);
    expect(v.ok).toBe(false);
    expect(v.reviewRan).toBe(false);
    expect(v.feedback).toMatch(/review could not run/i);
  });
});

describe("buildFeaturePrBody", () => {
  it("stacks the spec and every member's outcome line", () => {
    const body = buildFeaturePrBody({
      context: "The approved spec.",
      description: "Short label.",
      outcomes: [
        { title: "Login", outcome: "Users can log in with Apple." },
        { title: "Unreported", outcome: "" },
      ],
      featureId: "f1",
    });
    expect(body).toContain("The approved spec.");
    expect(body).toContain("Users can log in with Apple.");
    // A member that never reported an outcome is still listed — an absent line
    // is information, and dropping the row would hide that the task ran at all.
    expect(body).toContain("Unreported");
    expect(body).toContain("f1");
  });
});
