import { beforeEach, describe, expect, it, vi } from "vitest";

// The catch-up that runs at the start of every RESUME turn (lib/runner.ts).
//
// It used to fire only for fast-forwards, which meant a task stopped syncing the
// instant it committed anything and then drifted one commit further behind for
// every merge that landed while it sat waiting on the user. These cover both
// tiers plus the two states that must be left alone: a predicted conflict and a
// dirty tree.
//
// Only the agent turn is scripted — the git, the store and the runner are real,
// so what's under test is whether the branch actually moved.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { ensureWorktree } from "@/lib/git";
import { startResumeTurn } from "@/lib/runner";
import { hasTurn } from "@/lib/abort";
import { createProject, createTask, updateProject, updateTask, getTask, listMessages } from "@/lib/store";
import { commitFile, git, makeRepo, uid, writeFile } from "./helpers";

beforeEach(() => {
  runTurnMock.mockReset();
  runTurnMock.mockImplementation(async function* (task: { id: string }) {
    yield { type: "session", sessionId: `s-${task.id}` };
    yield { type: "assistant", content: "ok" };
    yield { type: "done", sessionId: `s-${task.id}` };
  });
});

/** A started task on a real repo, with its own worktree branched off main. */
async function fixture() {
  const repo = await makeRepo();
  const project = updateProject(createProject({ name: `Sync-${uid()}` }).id, { repo_path: repo, branch: "main" })!;
  const row = createTask({ project_id: project.id, title: "T", description: "d" });
  const wt = await ensureWorktree(repo, row.id);
  if (!wt) throw new Error("ensureWorktree returned null in fixture");
  const task = updateTask(row.id, {
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
    started: 1,
  })!;
  return { repo, project, task, wt };
}

/** Run one resume turn to completion. */
async function resume(project: Parameters<typeof startResumeTurn>[1], taskId: string) {
  await startResumeTurn(getTask(taskId)!, project, "carry on");
  await vi.waitFor(() => expect(hasTurn(taskId)).toBe(false), { timeout: 10_000 });
}

const caughtUp = (taskId: string) =>
  listMessages(taskId).some((m) => m.role === "system" && /Caught up to main/.test(m.content));

describe("resume-turn catch-up", () => {
  it("merges the base in when the task has its own commits and the merge is clean", async () => {
    const { repo, project, task, wt } = await fixture();
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    const mainTip = await commitFile(repo, "main.txt", "main\n", "main edit");

    await resume(project, task.id);

    // The regression this guards: pre-fix `ahead > 0` disqualified the catch-up
    // entirely, so main's commit never reached the branch.
    await expect(git(wt.path, "merge-base", "--is-ancestor", mainTip, "HEAD")).resolves.toBe("");
    expect(getTask(task.id)!.base_sha).toBe(mainTip);
    expect(caughtUp(task.id)).toBe(true);
    // The task's own work survived the merge.
    expect(await git(wt.path, "cat-file", "-e", "HEAD:task.txt").then(() => true)).toBe(true);
  }, 20_000);

  it("still fast-forwards when the task has no commits of its own", async () => {
    const { repo, project, task, wt } = await fixture();
    const mainTip = await commitFile(repo, "main.txt", "main\n", "base advance");

    await resume(project, task.id);

    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(mainTip);
    expect(getTask(task.id)!.base_sha).toBe(mainTip);
    expect(caughtUp(task.id)).toBe(true);
  }, 20_000);

  it("leaves a predicted conflict for the Sync banner rather than starting the turn on a conflicted tree", async () => {
    const { repo, project, task, wt } = await fixture();
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const tip = await git(wt.path, "rev-parse", "HEAD");

    await resume(project, task.id);

    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(wt.path, "status", "--porcelain")).toBe(""); // no merge started, no markers
    expect(caughtUp(task.id)).toBe(false);
  }, 20_000);

  it("never commits a dirty tree to catch up", async () => {
    const { repo, project, task, wt } = await fixture();
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main edit");
    writeFile(wt.path, "scratch.txt", "uncommitted\n");
    const tip = await git(wt.path, "rev-parse", "HEAD");

    await resume(project, task.id);

    // prepareWorktreeMerge commits pending edits to get a clean tree; doing that
    // to an agent's half-finished work at turn start is not the runner's call.
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(wt.path, "status", "--porcelain")).toContain("scratch.txt");
    expect(caughtUp(task.id)).toBe(false);
  }, 20_000);
});
