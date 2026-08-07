import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The controller, end to end: the REAL runner, the REAL git, the REAL store.
// Only the two things that reach outside the box are scripted — the agent's turn
// and the gate's verdict — so what's actually under test is whether the
// scheduler starts, gates, merges and hands back correctly.
//
// lib/gates is mocked here, which is exactly why the gate's own tests live in
// tests/autopilot.test.ts: a file can't both replace a module and test it.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

const { gateMock, advisoryMock, featureGateMock, testsMock } = vi.hoisted(() => ({
  gateMock: vi.fn(),
  advisoryMock: vi.fn(),
  featureGateMock: vi.fn(),
  testsMock: vi.fn(),
}));
vi.mock("@/lib/gates", () => ({
  runGate: (...a: unknown[]) => gateMock(...a),
  gateIsAdvisory: () => advisoryMock(),
  runFeatureGate: (...a: unknown[]) => featureGateMock(...a),
  runTestsIn: (...a: unknown[]) => testsMock(...a),
  // Not mocked — it's pure string assembly and the message is what the
  // assertions read.
  featureGateFailure: (feature: { branch: string }, project: { test_command: string }, r: { output: string; inconclusive?: boolean }) =>
    r.inconclusive
      ? `The feature gate could not run: ${r.output}`
      : `\`${project.test_command}\` fails on ${feature.branch}, so this feature was not shipped.\n\n${r.output}`,
}));

// `gh` isn't reachable from the suite, and the PR is the one step that genuinely
// leaves the machine. buildFeaturePrBody stays real (it has its own test).
const { prMock } = vi.hoisted(() => ({ prMock: vi.fn() }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  createBranchPr: (...a: unknown[]) => prMock(...a),
}));

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ensureAutopilot, sweep, GATE_STALL_MS } from "@/lib/autopilot";
import { startInitialTurn } from "@/lib/runner";
import { getDb } from "@/lib/db";
import { createFeatureBranch } from "@/lib/git";
import { AUTOPILOT_CONCURRENCY, AUTOPILOT_ATTEMPTS } from "@/lib/config";
import { makeRepo } from "./helpers";
import {
  createProject,
  createFeature,
  createTask,
  updateFeature,
  updateProject,
  getFeature,
  getTask,
  setTaskDeps,
  updateTask,
} from "@/lib/store";
import { publishGlobal } from "@/lib/events";

beforeEach(() => {
  gateMock.mockReset();
  gateMock.mockResolvedValue({ ok: true, feedback: "", testsRan: true, reviewRan: true });
  advisoryMock.mockReset();
  advisoryMock.mockReturnValue(false);
  featureGateMock.mockReset();
  featureGateMock.mockResolvedValue({ ok: true, ran: true, output: "" });
  testsMock.mockReset();
  testsMock.mockResolvedValue({ ran: true, ok: true, output: "" });
  prMock.mockReset();
  prMock.mockResolvedValue({ ok: true, url: "https://example/pull/7" });
  runTurnMock.mockReset();
  // Default scripted turn: write a file into the worktree so there is something
  // real to merge, then end. The runner settles it to awaiting_input=1, which is
  // the "handed back to the user" state autopilot gates on.
  runTurnMock.mockImplementation(async function* (task: { id: string; worktree_path: string }) {
    yield { type: "session", sessionId: `s-${task.id}` };
    if (task.worktree_path) fs.writeFileSync(`${task.worktree_path}/${task.id}.txt`, "work\n");
    yield { type: "assistant", content: "done" };
    yield { type: "done", sessionId: `s-${task.id}` };
  });
  process.env.ORCH_FEATURE_AUTOPILOT = "1";
});

afterEach(() => {
  delete process.env.ORCH_FEATURE_AUTOPILOT;
});

/** A project on a real repo with an autopilot feature on its own integration
 *  branch, plus `n` committed member tasks. Nothing is started yet. */
async function planFixture(n: number, opts: { autopilot?: boolean } = {}) {
  const repo = await makeRepo();
  const project = updateProject(createProject({ name: `P-${Math.random().toString(36).slice(2, 8)}` }).id, {
    repo_path: repo,
    branch: "main",
  })!;
  const created = createFeature({ project_id: project.id, name: `Feat-${Math.random().toString(36).slice(2, 8)}` });
  const branch = `feature/${created.id}`;
  await createFeatureBranch(repo, branch, "main");
  // Re-read: updateFeature returns the fresh row, and `created` still carries
  // the empty branch it was made with.
  const feature = updateFeature(created.id, { branch, autopilot: opts.autopilot === false ? 0 : 1 })!;
  const tasks = Array.from({ length: n }, (_, i) =>
    createTask({
      project_id: project.id,
      title: `Task ${i + 1}`,
      description: `do thing ${i + 1}`,
      feature_id: feature.id,
    })
  );
  return { repo, project, feature, tasks };
}

/** Which member tasks the scheduler has actually launched a turn for. */
const launchedIds = () => runTurnMock.mock.calls.map((c) => (c[0] as { id: string }).id);

describe("autopilot scheduler", () => {
  it("does nothing when the feature's switch is off", async () => {
    const { project, tasks } = await planFixture(2, { autopilot: false });
    await sweep(project.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(tasks.every((t) => getTask(t.id)!.started === 0)).toBe(true);
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it("starts ready members up to the concurrency cap", async () => {
    const { project } = await planFixture(AUTOPILOT_CONCURRENCY + 2);
    // Park the gate so the event-driven loop can't race ahead and free slots
    // while we're counting.
    gateMock.mockImplementation(() => new Promise(() => {}));
    await sweep(project.id);
    expect(launchedIds()).toHaveLength(AUTOPILOT_CONCURRENCY);
  });

  it("will not start a task whose dependency has not landed", async () => {
    const { project, tasks } = await planFixture(2);
    setTaskDeps(tasks[1].id, [tasks[0].id]);
    gateMock.mockImplementation(() => new Promise(() => {}));
    await sweep(project.id);
    expect(launchedIds()).toEqual([tasks[0].id]);
  });

  // The unblock signal. A dependency can stop blocking without any turn ending —
  // a status set by hand, a cancel, or autopilot's own land() publishing a member
  // as merged from a feature this pass had already walked. Only turn_end woke the
  // scheduler, so those dependents sat until the 60s heartbeat noticed work that
  // had been ready all along.
  it("starts a dependent as soon as its blocker is marked done, with no sweep of its own", async () => {
    const { project, tasks } = await planFixture(2);
    setTaskDeps(tasks[1].id, [tasks[0].id]);
    // Parked so the blocker is never launched by the sweep below — the only
    // thing that may start tasks[1] is the completion signal.
    updateTask(tasks[0].id, { status: "on_hold" });
    ensureAutopilot();
    await sweep(project.id);
    expect(launchedIds()).toEqual([]);

    // Exactly what PATCH /api/tasks/[id] and land() do, and nothing else.
    updateTask(tasks[0].id, { status: "done" });
    publishGlobal(tasks[0].id, { type: "task_updated" });

    await vi.waitFor(() => expect(launchedIds()).toEqual([tasks[1].id]), { timeout: 5_000 });
  }, 15_000);

  it("merges a passing task into the feature branch and marks it done", async () => {
    const { repo, project, feature, tasks } = await planFixture(1);
    ensureAutopilot();
    await sweep(project.id);
    await vi.waitFor(() => expect(getTask(tasks[0].id)!.status).toBe("done"), { timeout: 15_000 });

    const t = getTask(tasks[0].id)!;
    expect(t.merged_at).toBeGreaterThan(0);
    expect(t.blocked_reason).toBe("");
    // The work is really on the integration branch, not merely flagged as done.
    const files = execFileSync("git", ["-C", repo, "ls-tree", "--name-only", feature.branch], { encoding: "utf8" });
    expect(files).toContain(`${tasks[0].id}.txt`);
  }, 30_000);

  it("feeds a failing gate back as a turn, then blocks at the attempt cap", async () => {
    const { project, tasks } = await planFixture(1);
    gateMock.mockResolvedValue({ ok: false, feedback: "You left a TODO.", testsRan: true, reviewRan: true });
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(() => expect(getTask(tasks[0].id)!.blocked_reason).not.toBe(""), { timeout: 15_000 });
    const t = getTask(tasks[0].id)!;
    expect(t.status).not.toBe("done");
    expect(t.awaiting_input).toBe(1);
    expect(t.blocked_reason).toContain("You left a TODO.");
    // The initial turn plus at most one retry per allowed attempt — bounded, not
    // an agent looping through the user's quota.
    expect(launchedIds()).toHaveLength(AUTOPILOT_ATTEMPTS + 1);
  }, 30_000);

  // An unrunnable reviewer (usage limit, no connected utility agent, a died
  // turn) is a statement about the reviewer, not about the diff. Charging it to
  // the task burned both retries on an outage and then blocked finished work
  // behind it — and sent the agent the error string as if it were review
  // feedback to act on.
  it("does not charge an inconclusive gate to the task, and lands it once the reviewer is back", async () => {
    const { project, tasks } = await planFixture(1);
    gateMock.mockResolvedValue({
      ok: false,
      inconclusive: true,
      feedback: "The review could not run: usage limit reached",
      testsRan: true,
      reviewRan: false,
    });
    ensureAutopilot();
    await sweep(project.id);
    await vi.waitFor(() => expect(gateMock).toHaveBeenCalled(), { timeout: 15_000 });

    const during = getTask(tasks[0].id)!;
    expect(during.blocked_reason).toBe("");
    expect(during.gate_attempts).toBe(0); // full retry budget intact for a real review
    expect(during.status).not.toBe("done");
    // Settled and re-gatable, but NOT flagged for the user: an outage the gate
    // will retry on its own is not something a human has to come and do.
    expect(during.awaiting_input).toBe(0);
    expect(during.running).toBe(0);
    expect(during.started).toBe(1);
    // The outage was never sent into the task as work to do.
    expect(launchedIds()).toEqual([tasks[0].id]);
    expect(runTurnMock.mock.calls.some((c) => /could not run/.test(String(c[2])))).toBe(false);

    gateMock.mockResolvedValue({ ok: true, feedback: "", testsRan: true, reviewRan: true });
    await sweep(project.id);

    await vi.waitFor(() => expect(getTask(tasks[0].id)!.status).toBe("done"), { timeout: 15_000 });
    expect(getTask(tasks[0].id)!.merged_at).toBeGreaterThan(0);
  }, 40_000);

  it("keeps working an independent sibling while one member is blocked", async () => {
    const { project, tasks } = await planFixture(2);
    const [bad, good] = tasks;
    gateMock.mockImplementation(async (task: { id: string }) =>
      task.id === bad.id
        ? { ok: false, feedback: "nope", testsRan: true, reviewRan: true }
        : { ok: true, feedback: "", testsRan: true, reviewRan: true }
    );
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(
      () => {
        expect(getTask(bad.id)!.blocked_reason).not.toBe("");
        expect(getTask(good.id)!.status).toBe("done");
      },
      { timeout: 20_000 }
    );
  }, 40_000);

  it("hands the finished feature back as one PR, exactly once", async () => {
    const { project, feature, tasks } = await planFixture(2);
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(() => expect(getFeature(feature.id)!.pr_url).toBe("https://example/pull/7"), { timeout: 20_000 });
    expect(tasks.every((t) => getTask(t.id)!.status === "done")).toBe(true);
    // A later sweep must not open a second PR for the same feature.
    await sweep(project.id);
    expect(prMock).toHaveBeenCalledTimes(1);
    expect(prMock.mock.calls[0][0]).toMatchObject({ branch: feature.branch, baseBranch: "main" });
  }, 40_000);

  // Plan → build → review as ONE run: work filed after the approval (a planner
  // still filing, or a member discovering follow-up work) is accepted and run,
  // not left in the tray for the feature to sail past.
  it("accepts tasks suggested into an armed feature and runs them", async () => {
    const { project, feature } = await planFixture(0);
    const late = createTask({
      project_id: project.id,
      title: "Filed by the planner after approval",
      feature_id: feature.id,
      suggested: true,
    });
    // Park the TURN, not the gate: accepting a suggestion publishes task_updated,
    // which marks the project dirty and makes sweep() loop once more — a gate
    // mock that never resolves would hang that second pass forever, and with it
    // the await below. A turn that never ends parks the member just as firmly
    // (it is never settled, so it is never gated) without blocking the sweep.
    runTurnMock.mockImplementation(async function* (task: { id: string }) {
      yield { type: "session", sessionId: `s-${task.id}` };
      await new Promise(() => {});
    });

    await sweep(project.id);

    expect(getTask(late.id)!.suggested).toBe(0);
    expect(launchedIds()).toEqual([late.id]);
    // The feature must not have been called finished while that task was in flight.
    expect(prMock).not.toHaveBeenCalled();
  });

  // Each member passed its own gate in its own worktree, which proves nothing
  // about the branch they were all merged into. A green-in-isolation set CAN
  // assemble into a red branch with no git conflict anywhere to warn anyone —
  // that is exactly how a feature shipped and broke cross-platform determinism.
  it("refuses to open the PR when the assembled feature branch fails its tests", async () => {
    const { project, feature, tasks } = await planFixture(2);
    featureGateMock.mockResolvedValue({ ok: false, ran: true, output: "determinism BROKEN" });
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(() => expect(featureGateMock).toHaveBeenCalled(), { timeout: 20_000 });
    // Members still landed on the integration branch — the branch is the unit
    // that is refused, not each task's work.
    await vi.waitFor(() => expect(tasks.every((t) => getTask(t.id)!.status === "done")).toBe(true), { timeout: 20_000 });

    expect(prMock).not.toHaveBeenCalled();
    expect(getFeature(feature.id)!.pr_url).toBe("");
    // The refusal reaches the user rather than a log.
    const blocked = tasks.map((t) => getTask(t.id)!).filter((t) => t.blocked_reason);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].blocked_reason).toContain("determinism BROKEN");
  }, 40_000);

  it("opens the PR once the feature branch is green", async () => {
    const { project, feature } = await planFixture(1);
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(() => expect(getFeature(feature.id)!.pr_url).toBe("https://example/pull/7"), { timeout: 20_000 });
    expect(featureGateMock).toHaveBeenCalled();
  }, 40_000);

  it("in shadow mode it gates but never merges", async () => {
    advisoryMock.mockReturnValue(true);
    const { project, tasks } = await planFixture(1);
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(() => expect(getTask(tasks[0].id)!.blocked_reason).not.toBe(""), { timeout: 15_000 });
    const t = getTask(tasks[0].id)!;
    expect(gateMock).toHaveBeenCalled();
    expect(t.status).not.toBe("done");
    expect(t.merged_at).toBe(0);
    expect(t.blocked_reason).toMatch(/shadow mode/i);
  }, 30_000);

  // The complaint this came from: every task in an unattended run lit up the
  // "needs you" pill (and fired a desktop notification) the moment its turn
  // ended, for the whole length of the gate — minutes on a real project — and
  // then merged itself with nobody having done anything. A turn ending under
  // autopilot hands off to the gate, not to the user.
  it("a member's turn ending does not flag the user, but a hand-driven task's does", async () => {
    // Hold the gate open so the settled-but-not-yet-judged window is observable.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    gateMock.mockImplementation(async () => {
      await held;
      return { ok: true, feedback: "", testsRan: true, reviewRan: true };
    });

    const { project, tasks } = await planFixture(1);
    ensureAutopilot();
    await sweep(project.id);

    await vi.waitFor(() => expect(gateMock).toHaveBeenCalled(), { timeout: 15_000 });
    const mid = getTask(tasks[0].id)!;
    expect(mid.running).toBe(0); // the turn is over…
    expect(mid.awaiting_input).toBe(0); // …and it is autopilot's problem, not yours

    release();
    await vi.waitFor(() => expect(getTask(tasks[0].id)!.status).toBe("done"), { timeout: 15_000 });

    // Same runner, same turn, feature switch off: still the user's to pick up.
    const solo = await planFixture(1, { autopilot: false });
    await startInitialTurn(getTask(solo.tasks[0].id)!, solo.project);
    await vi.waitFor(() => expect(getTask(solo.tasks[0].id)!.running).toBe(0), { timeout: 15_000 });
    expect(getTask(solo.tasks[0].id)!.awaiting_input).toBe(1);
  }, 40_000);

  // Suppressing the flag can't mean suppressing the task: a gate that never
  // reaches a verdict has to surface eventually, or finished work sits in an
  // invisible row forever.
  it("escalates a gate that has been inconclusive for too long", async () => {
    const { project, tasks } = await planFixture(1);
    gateMock.mockResolvedValue({
      ok: false,
      inconclusive: true,
      feedback: "The review could not run: usage limit reached",
      testsRan: true,
      reviewRan: false,
    });
    ensureAutopilot();
    await sweep(project.id);
    await vi.waitFor(() => expect(gateMock).toHaveBeenCalled(), { timeout: 15_000 });
    expect(getTask(tasks[0].id)!.blocked_reason).toBe(""); // still inside the grace

    // Backdate the row past the grace — the same thing a long outage does, and
    // the reason the check needs no stored counter.
    getDb()
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(Date.now() - GATE_STALL_MS - 1000, tasks[0].id);
    await sweep(project.id);

    await vi.waitFor(() => expect(getTask(tasks[0].id)!.blocked_reason).not.toBe(""), { timeout: 15_000 });
    const t = getTask(tasks[0].id)!;
    expect(t.awaiting_input).toBe(1); // back in front of the user, with a reason
    expect(t.blocked_reason).toMatch(/unable to run/i);
    expect(t.gate_attempts).toBe(0); // an outage still isn't the task's fault
  }, 40_000);
});
