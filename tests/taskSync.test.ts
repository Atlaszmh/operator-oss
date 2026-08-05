import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createProject, createFeature, updateFeature, getFeature, createTask, getTask, updateTask } from "@/lib/store";
import { createFeatureBranch, ensureWorktree, mergeTask, fastForwardWorktree } from "@/lib/git";
import { catchUpWorktree, syncTasksToBase } from "@/lib/featureSync";
import { POST as mergeRoute } from "@/app/api/tasks/[id]/merge/route";
import { git, makeRepo, commitFile } from "./helpers";

// The half that bites hardest. A feature runs several tasks at once BY DESIGN
// (AUTOPILOT_CONCURRENCY), so sibling branches race the same base — the racing
// isn't incidental, it is the execution model. A task that only ever
// fast-forwards stops syncing the instant it commits anything, then drifts one
// commit further behind for every sibling that lands while it works, so the
// conflict it eventually hits is the size of the whole race.

/** A project + feature branch + N task worktrees cut from it, all wired in the DB. */
async function featureWithTasks(name: string, branch: string, titles: string[]) {
  const repo = await makeRepo();
  const project = createProject({ name, repo_path: repo, branch: "main" });
  const feature = createFeature({ project_id: project.id, name: `${name} feature` });
  const cut = await createFeatureBranch(repo, branch, "main");
  updateFeature(feature.id, { branch, base_sha: cut!.sha });

  const tasks = [];
  for (const title of titles) {
    const t = createTask({ project_id: project.id, title, feature_id: feature.id });
    const wt = (await ensureWorktree(repo, t.id, branch))!;
    updateTask(t.id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha, status: "in_progress" });
    tasks.push({ ...getTask(t.id)!, wtPath: wt.path });
  }
  return { repo, project, feature: getFeature(feature.id)!, tasks };
}

describe("catchUpWorktree — the ladder autopilot was missing", () => {
  it("merges the base in even when the task has diverged, not just fast-forwards", async () => {
    // The exact case `git merge --ff-only` cannot handle, and the reason
    // autopilot's pre-gate catch-up silently did nothing for any real task.
    const { repo, project, tasks } = await featureWithTasks("Diverged", "feat/div", ["mine"]);
    const mine = tasks[0];

    await commitFile(mine.wtPath, "mine.txt", "my work\n", "my own commit");
    await git(repo, "checkout", "feat/div");
    await commitFile(repo, "theirs.txt", "their work\n", "a sibling landed");

    // Diverged: a fast-forward is impossible from here, which is where the old
    // code gave up without saying so.
    expect(await fastForwardWorktree(mine.wtPath, "feat/div")).toBe(false);

    const r = await catchUpWorktree(project, getTask(mine.id)!, "feat/div");

    expect(r.caughtUp).toBe(true);
    expect(r.behind).toBe(1);
    // The task now HAS the sibling's work, so its own merge later is trivial.
    expect(await git(mine.wtPath, "log", "--format=%s")).toContain("a sibling landed");
  });

  it("leaves a dirty worktree alone rather than committing an agent's half-finished edits", async () => {
    const { repo, project, tasks } = await featureWithTasks("Dirty", "feat/dirty", ["wip"]);
    const wip = tasks[0];
    await git(repo, "checkout", "feat/dirty");
    await commitFile(repo, "landed.txt", "x\n", "sibling landed");
    fs.writeFileSync(`${wip.wtPath}/scratch.txt`, "half a thought");

    const r = await catchUpWorktree(project, getTask(wip.id)!, "feat/dirty");

    expect(r.skippedDirty).toBe(true);
    expect(r.caughtUp).toBe(false);
  });

  it("reports a real conflict instead of mangling the tree", async () => {
    const { repo, project, tasks } = await featureWithTasks("Clash", "feat/clash3", ["mine"]);
    const mine = tasks[0];
    await commitFile(mine.wtPath, "hub.txt", "mine\n", "task edits the hub");
    await git(repo, "checkout", "feat/clash3");
    await commitFile(repo, "hub.txt", "theirs\n", "sibling edits the hub");

    const r = await catchUpWorktree(project, getTask(mine.id)!, "feat/clash3");

    expect(r.caughtUp).toBe(false);
    expect(r.conflicts).toContain("hub.txt");
  });

  it("is a no-op when the task is already current", async () => {
    const { project, tasks } = await featureWithTasks("Current", "feat/cur", ["idle"]);
    const r = await catchUpWorktree(project, getTask(tasks[0].id)!, "feat/cur");
    expect(r.behind).toBe(0);
    expect(r.caughtUp).toBe(false);
  });
});

describe("syncTasksToBase — siblings follow the moment one lands", () => {
  it("catches an idle sibling up without it taking a turn", async () => {
    const { repo, project, tasks } = await featureWithTasks("Siblings", "feat/sib", ["first", "second"]);
    const [first, second] = tasks;

    await commitFile(first.wtPath, "first.txt", "1\n", "first task work");
    await commitFile(second.wtPath, "second.txt", "2\n", "second task work");
    const merged = await mergeTask({
      repoPath: repo,
      worktreePath: first.wtPath,
      workBranch: first.work_branch,
      baseBranch: "feat/sib",
      message: "first lands",
    });
    expect(merged.ok).toBe(true);

    expect(await git(second.wtPath, "log", "--format=%s")).not.toContain("first task work");

    const results = await syncTasksToBase(project, "feat/sib", { except: first.id });

    expect(results).toHaveLength(1);
    expect(results[0].caughtUp).toBe(true);
    // THE POINT: the second task carries the first's work with no turn and no
    // user action, so its own merge later is a no-op instead of a conflict.
    expect(await git(second.wtPath, "log", "--format=%s")).toContain("first task work");
  });

  it("never touches a worktree with a live turn", async () => {
    // Moving the tree under a running agent would corrupt work in progress.
    const { repo, project, tasks } = await featureWithTasks("Running", "feat/run", ["busy"]);
    const busy = tasks[0];
    updateTask(busy.id, { running: 1 });
    await git(repo, "checkout", "feat/run");
    await commitFile(repo, "landed.txt", "x\n", "something landed");

    expect(await syncTasksToBase(project, "feat/run")).toEqual([]);
    expect(await git(busy.wtPath, "log", "--format=%s")).not.toContain("something landed");
  });

  it("skips finished tasks and the one that just landed", async () => {
    const { repo, project, tasks } = await featureWithTasks("Skips", "feat/skip", ["lander", "finished"]);
    const [lander, finished] = tasks;
    updateTask(finished.id, { status: "done" });
    await git(repo, "checkout", "feat/skip");
    await commitFile(repo, "landed.txt", "x\n", "landed");

    expect(await syncTasksToBase(project, "feat/skip", { except: lander.id })).toEqual([]);
  });

  it("one conflicted sibling does not stop the others catching up", async () => {
    const { repo, project, tasks } = await featureWithTasks("Mixed", "feat/mixed", ["clash", "fine"]);
    const [clash, fine] = tasks;
    await commitFile(clash.wtPath, "hub.txt", "mine\n", "clashing task");
    await commitFile(fine.wtPath, "own.txt", "ok\n", "independent task");
    await git(repo, "checkout", "feat/mixed");
    await commitFile(repo, "hub.txt", "theirs\n", "base moved the hub");

    const byId = Object.fromEntries((await syncTasksToBase(project, "feat/mixed")).map((r) => [r.taskId, r]));

    expect(byId[clash.id].caughtUp).toBe(false);
    expect(byId[clash.id].conflicts).toContain("hub.txt");
    expect(byId[fine.id].caughtUp).toBe(true);
    expect(await git(fine.wtPath, "log", "--format=%s")).toContain("base moved the hub");
  });
});

describe("the merge route sweeps siblings", () => {
  it("merging one task catches its sibling up, unprompted", async () => {
    // Pins the WIRING: the sweep passing its own tests is worthless if no
    // landing path calls it.
    const { project, tasks } = await featureWithTasks("Route Sib", "feat/routesib", ["lands", "waits"]);
    const [lands, waits] = tasks;
    await commitFile(lands.wtPath, "landed.txt", "work\n", "the landing task");
    await commitFile(waits.wtPath, "waiting.txt", "wip\n", "the waiting task");

    const res = await mergeRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: lands.id }),
    });
    expect(res.status).toBe(200);

    expect(await git(waits.wtPath, "log", "--format=%s")).toContain("the landing task");
  });
});
