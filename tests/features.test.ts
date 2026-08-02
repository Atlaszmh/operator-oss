import { describe, it, expect } from "vitest";
import {
  createProject,
  createFeature,
  getFeature,
  findFeature,
  listFeatures,
  updateFeature,
  deleteFeature,
  deleteProject,
  createTask,
  getTask,
  updateTask,
  listTasks,
  taskBaseBranch,
  featureTasksWithWorktrees,
  featureUnfinishedTasks,
} from "@/lib/store";
import { createSuggestedTask, createSuggestedFeature } from "@/lib/agentTools";
import { buildProjectContext } from "@/lib/agents/shared";
import { ensureWorktree, mergeTask, mergeFeature, createFeatureBranch, worktreeSyncStatus } from "@/lib/git";
import { git, makeRepo, commitFile, uid } from "./helpers";

// ---------------------------------------------------------------- storage

describe("features — storage and rollup", () => {
  it("deleting a feature keeps its tasks, un-grouped", () => {
    // The convention exception from the design: everywhere else in this app
    // delete is a hard delete of the thing AND what it is. A feature is a label
    // OVER tasks, so removing it must not destroy the work filed under it.
    // This test is here to stop a future refactor "fixing" it into a cascade.
    const project = createProject({ name: "Keep" });
    const feature = createFeature({ project_id: project.id, name: "Billing v2" });
    const a = createTask({ project_id: project.id, title: "A", feature_id: feature.id });
    const b = createTask({ project_id: project.id, title: "B", feature_id: feature.id });

    deleteFeature(feature.id);

    expect(getFeature(feature.id)).toBeUndefined();
    expect(getTask(a.id)).toBeDefined();
    expect(getTask(b.id)).toBeDefined();
    expect(getTask(a.id)!.feature_id).toBeNull();
    expect(getTask(b.id)!.feature_id).toBeNull();
  });

  it("deleting the project still cascades its features away", () => {
    const project = createProject({ name: "Cascade" });
    const feature = createFeature({ project_id: project.id, name: "Gone" });
    deleteProject(project.id);
    expect(getFeature(feature.id)).toBeUndefined();
  });

  it("allows the same feature name in two different projects", () => {
    const one = createProject({ name: "P1" });
    const two = createProject({ name: "P2" });
    const a = createFeature({ project_id: one.id, name: "Search" });
    const b = createFeature({ project_id: two.id, name: "Search" });
    expect(a.id).not.toBe(b.id);
    expect(findFeature(one.id, "Search")!.id).toBe(a.id);
    expect(findFeature(two.id, "Search")!.id).toBe(b.id);
  });

  it("findFeature resolves by id, exact name, and name case-insensitively", () => {
    const project = createProject({ name: "Resolve" });
    const feature = createFeature({ project_id: project.id, name: "Billing v2" });
    expect(findFeature(project.id, feature.id)!.id).toBe(feature.id);
    expect(findFeature(project.id, "Billing v2")!.id).toBe(feature.id);
    expect(findFeature(project.id, "billing V2")!.id).toBe(feature.id);
    expect(findFeature(project.id, "nope")).toBeUndefined();
    // Project-scoped: another project's id must not resolve here.
    const other = createProject({ name: "Resolve2" });
    expect(findFeature(other.id, feature.id)).toBeUndefined();
  });

  it("rolls up progress, excluding suggested from the ratio and cancelled entirely", () => {
    const project = createProject({ name: "Rollup" });
    const f = createFeature({ project_id: project.id, name: "F" });
    const mk = (title: string, patch: Parameters<typeof updateTask>[1] = {}, suggested = false) => {
      const t = createTask({ project_id: project.id, title, feature_id: f.id, suggested });
      if (Object.keys(patch).length) updateTask(t.id, patch);
      return t;
    };
    mk("done-1", { status: "done" });
    mk("done-2", { status: "done" });
    mk("open", { status: "in_progress" });
    mk("cancelled", { status: "cancelled" });
    mk("proposed", {}, true);
    mk("waiting", { status: "in_progress", awaiting_input: 1 });

    const row = listFeatures(project.id).find((x) => x.id === f.id)!;
    // total counts non-suggested, non-cancelled: done-1, done-2, open, waiting.
    expect(row.total).toBe(4);
    expect(row.done).toBe(2);
    expect(row.suggested_count).toBe(1);
    expect(row.awaiting_count).toBe(1);
  });

  it("reports zeroes for a feature with no tasks rather than dropping the row", () => {
    const project = createProject({ name: "Empty" });
    const f = createFeature({ project_id: project.id, name: "Fresh" });
    const row = listFeatures(project.id).find((x) => x.id === f.id)!;
    expect(row).toMatchObject({ total: 0, done: 0, suggested_count: 0, awaiting_count: 0 });
  });

  it("keeps feature_id through an unrelated updateTask", () => {
    // updateTask writes every column; a missing feature_id in that statement
    // would silently un-group a task on any edit.
    const project = createProject({ name: "Persist" });
    const f = createFeature({ project_id: project.id, name: "F" });
    const t = createTask({ project_id: project.id, title: "T", feature_id: f.id });
    updateTask(t.id, { title: "renamed" });
    expect(getTask(t.id)!.feature_id).toBe(f.id);
    expect(listTasks(project.id).find((x) => x.id === t.id)!.feature_id).toBe(f.id);
  });
});

// ------------------------------------------------------------ prompt layer

describe("features — prompt layering", () => {
  it("includes the feature context for a member task and omits it for a loose one", () => {
    const project = createProject({ name: "Ctx", context: "project-level context" });
    const f = createFeature({ project_id: project.id, name: "Billing v2", description: "not in the prompt", context: "stripe-only rules" });
    const member = getTask(createTask({ project_id: project.id, title: "member", feature_id: f.id }).id)!;
    const loose = getTask(createTask({ project_id: project.id, title: "loose" }).id)!;

    const withFeature = buildProjectContext(project, member);
    expect(withFeature).toContain("project-level context");
    expect(withFeature).toContain('part of the feature "Billing v2"');
    expect(withFeature).toContain("stripe-only rules");
    // description is a UI label, not prompt material.
    expect(withFeature).not.toContain("not in the prompt");

    const without = buildProjectContext(project, loose);
    expect(without).toContain("project-level context");
    // The NAME still appears further down, in the planner guidance's list of
    // existing features — that's deliberate. What must be absent is the
    // membership claim and the feature's context.
    expect(without).not.toContain('part of the feature "Billing v2"');
    expect(without).not.toContain("stripe-only rules");
  });

  it("reports the feature branch as the task's git branch when one is set", () => {
    const project = createProject({ name: "Branchy", branch: "main" });
    const f = createFeature({ project_id: project.id, name: "Feat" });
    const t = getTask(createTask({ project_id: project.id, title: "t", feature_id: f.id }).id)!;

    // No integration branch yet — the project branch is the honest answer.
    expect(buildProjectContext(project, t)).toContain("Git branch: main");

    updateFeature(f.id, { branch: "orch/feat/feat" });
    const after = buildProjectContext(project, getTask(t.id)!);
    expect(after).toContain("Git branch: orch/feat/feat");
    expect(after).not.toContain("Git branch: main");
  });

  it("lists existing features in the planner guidance", () => {
    const project = createProject({ name: "Guide" });
    createFeature({ project_id: project.id, name: "Alpha" });
    const archived = createFeature({ project_id: project.id, name: "Zulu" });
    updateFeature(archived.id, { archived: 1 });
    const t = getTask(createTask({ project_id: project.id, title: "t" }).id)!;
    const out = buildProjectContext(project, t);
    expect(out).toContain("suggest_feature");
    expect(out).toContain('"Alpha"');
    // Archived features are out of the working set — don't offer them.
    expect(out).not.toContain('"Zulu"');
  });
});

// -------------------------------------------------------------------- git

describe("features — base branch resolution", () => {
  it("resolves the feature branch, then falls back to the project branch", () => {
    const project = createProject({ name: "Base", branch: "main" });
    const f = createFeature({ project_id: project.id, name: "F" });
    const loose = getTask(createTask({ project_id: project.id, title: "loose" }).id)!;
    const member = getTask(createTask({ project_id: project.id, title: "member", feature_id: f.id }).id)!;

    expect(taskBaseBranch(loose, project)).toBe("main");
    // Feature with no branch set behaves exactly like no feature at all.
    expect(taskBaseBranch(member, project)).toBe("main");

    updateFeature(f.id, { branch: "orch/feat/f" });
    expect(taskBaseBranch(getTask(member.id)!, project)).toBe("orch/feat/f");
    expect(taskBaseBranch(loose, project)).toBe("main");
  });
});

describe("features — worktrees and merging", () => {
  it("cuts a worktree from the given base branch, not the repo's HEAD", async () => {
    const repo = await makeRepo();
    // Put a distinct commit on a feature branch, then move the repo's HEAD to
    // ANOTHER branch. Before ensureWorktree took a base, base_sha came from HEAD
    // and the task would silently fork from the wrong place.
    await git(repo, "branch", "orch/feat/x");
    await git(repo, "checkout", "orch/feat/x");
    const featTip = await commitFile(repo, "feature.txt", "feature work\n", "feature commit");
    await git(repo, "checkout", "main");
    await git(repo, "checkout", "-b", "somewhere-else");

    const wt = await ensureWorktree(repo, uid(), "orch/feat/x");
    expect(wt).not.toBeNull();
    expect(wt!.baseSha).toBe(featTip);
    // And the worktree really contains the feature branch's content.
    expect(await git(wt!.path, "rev-parse", "HEAD")).toBe(featTip);
  });

  it("falls back to HEAD when the base branch does not exist", async () => {
    const repo = await makeRepo();
    const head = await git(repo, "rev-parse", "HEAD");
    const wt = await ensureWorktree(repo, uid(), "orch/feat/never-created");
    expect(wt).not.toBeNull();
    expect(wt!.baseSha).toBe(head);
  });

  it("merges a feature task into the feature branch, leaving the project branch alone", async () => {
    const repo = await makeRepo();
    const mainTip = await git(repo, "rev-parse", "main");
    const created = await createFeatureBranch(repo, "orch/feat/billing", "main");
    expect(created).not.toBeNull();
    expect(created!.created).toBe(true);

    const taskId = uid();
    const wt = (await ensureWorktree(repo, taskId, "orch/feat/billing"))!;
    await commitFile(wt.path, "billing.txt", "task work\n", "task commit");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "orch/feat/billing",
      message: "merge task",
    });
    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("orch/feat/billing");

    // The feature branch advanced; main did not.
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);
    const onFeature = await git(repo, "log", "--format=%s", "orch/feat/billing");
    expect(onFeature).toContain("task commit");
    const onMain = await git(repo, "log", "--format=%s", "main");
    expect(onMain).not.toContain("task commit");
  });

  it("mergeFeature lands every member task's work on the project branch at once", async () => {
    const repo = await makeRepo();
    await createFeatureBranch(repo, "orch/feat/multi", "main");

    for (const name of ["one", "two"]) {
      const wt = (await ensureWorktree(repo, uid(), "orch/feat/multi"))!;
      await commitFile(wt.path, `${name}.txt`, `${name}\n`, `task ${name}`);
      const r = await mergeTask({
        repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
        baseBranch: "orch/feat/multi", message: `merge ${name}`,
      });
      expect(r.ok).toBe(true);
    }

    const shipped = await mergeFeature({
      repoPath: repo, featureBranch: "orch/feat/multi", baseBranch: "main",
      message: "ship the feature",
    });
    expect(shipped.ok).toBe(true);

    const onMain = await git(repo, "log", "--format=%s", "main");
    expect(onMain).toContain("task one");
    expect(onMain).toContain("task two");
  });

  it("mergeFeature reports alreadyMerged instead of failing on a re-ship", async () => {
    const repo = await makeRepo();
    await createFeatureBranch(repo, "orch/feat/twice", "main");
    const wt = (await ensureWorktree(repo, uid(), "orch/feat/twice"))!;
    await commitFile(wt.path, "x.txt", "x\n", "the work");
    await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "orch/feat/twice", message: "m" });

    const first = await mergeFeature({ repoPath: repo, featureBranch: "orch/feat/twice", baseBranch: "main", message: "ship" });
    expect(first.ok).toBe(true);
    expect(first.alreadyMerged).toBeFalsy();

    const second = await mergeFeature({ repoPath: repo, featureBranch: "orch/feat/twice", baseBranch: "main", message: "ship again" });
    expect(second.ok).toBe(true);
    expect(second.alreadyMerged).toBe(true);
  });

  it("createFeatureBranch attaches to an existing branch instead of failing", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "mine");
    const res = await createFeatureBranch(repo, "mine", "main");
    expect(res).not.toBeNull();
    expect(res!.created).toBe(false);
    expect(res!.sha).toBe(await git(repo, "rev-parse", "mine"));
  });

  it("worktreeSyncStatus works with no worktree path (a feature branch has none)", async () => {
    const repo = await makeRepo();
    await createFeatureBranch(repo, "orch/feat/behind", "main");
    // Move main forward twice; the feature branch is now 2 behind, 0 ahead.
    await commitFile(repo, "a.txt", "a\n", "main a");
    await commitFile(repo, "b.txt", "b\n", "main b");

    const status = await worktreeSyncStatus({
      repoPath: repo,
      workBranch: "orch/feat/behind",
      baseBranch: "main",
    });
    expect(status.behind).toBe(2);
    expect(status.ahead).toBe(0);
    // No worktree to be dirty in — must not report a phantom dirty tree.
    expect(status.isDirty).toBe(false);
    expect(status.canFastForward).toBe(true);
  });
});

describe("features — guards", () => {
  it("lists member tasks holding a worktree, which is what freezes the branch setting", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Guard", repo_path: repo, branch: "main" });
    const f = createFeature({ project_id: project.id, name: "F" });
    const t = createTask({ project_id: project.id, title: "has worktree", feature_id: f.id });
    expect(featureTasksWithWorktrees(f.id)).toEqual([]);

    const wt = (await ensureWorktree(repo, t.id, "main"))!;
    updateTask(t.id, { worktree_path: wt.path, work_branch: wt.branch });
    expect(featureTasksWithWorktrees(f.id)).toEqual([{ id: t.id, title: "has worktree" }]);
  });

  it("lists unfinished members for the advisory ship guard, ignoring done/cancelled/suggested", () => {
    const project = createProject({ name: "Ship" });
    const f = createFeature({ project_id: project.id, name: "F" });
    const mk = (title: string, status: string, suggested = false) => {
      const t = createTask({ project_id: project.id, title, feature_id: f.id, suggested });
      updateTask(t.id, { status: status as never });
      return t;
    };
    mk("finished", "done");
    mk("abandoned", "cancelled");
    mk("proposal", "not_started", true);
    const open = mk("still going", "in_progress");

    expect(featureUnfinishedTasks(f.id)).toEqual([{ id: open.id, title: "still going" }]);
  });
});

// ------------------------------------------------------------- agent tools

describe("features — agent tools", () => {
  it("suggest_feature upserts by name rather than duplicating", () => {
    const project = createProject({ name: "Upsert" });
    const first = createSuggestedFeature(project, { name: "Billing v2", description: "d1", context: "c1" });
    const second = createSuggestedFeature(project, { name: "Billing v2", description: "d2", context: "c2" });

    expect(second.feature.id).toBe(first.feature.id);
    expect(second.feature.description).toBe("d2");
    expect(second.feature.context).toBe("c2");
    expect(second.text).toContain("Updated the existing feature");
    expect(listFeatures(project.id).filter((f) => f.name === "Billing v2")).toHaveLength(1);
  });

  it("a bare suggest_feature re-reference does not wipe existing context", () => {
    // A planner naming an existing feature to file work into it must not
    // silently blank the spec a previous call wrote.
    const project = createProject({ name: "NoWipe" });
    createSuggestedFeature(project, { name: "Auth", description: "d", context: "the important spec" });
    const again = createSuggestedFeature(project, { name: "Auth" });
    expect(again.feature.context).toBe("the important spec");
    expect(again.feature.description).toBe("d");
  });

  it("suggest_task files into an existing feature by name", () => {
    const project = createProject({ name: "File" });
    const f = createSuggestedFeature(project, { name: "Billing v2", context: "spec" }).feature;
    const { task, text } = createSuggestedTask(project, { title: "add hook", description: "", feature: "billing v2" });
    expect(getTask(task.id)!.feature_id).toBe(f.id);
    expect(text).toContain('Filed under "Billing v2"');
  });

  it("suggest_task auto-creates an unknown feature and says so", () => {
    const project = createProject({ name: "Auto" });
    const { task, text } = createSuggestedTask(project, { title: "t", description: "", feature: "Brand New" });
    const fid = getTask(task.id)!.feature_id;
    expect(fid).toBeTruthy();
    expect(getFeature(fid!)!.name).toBe("Brand New");
    expect(getFeature(fid!)!.context).toBe("");
    // The note is the feedback channel that gets a planner to supply context.
    expect(text).toContain("no feature context yet");
    expect(text).toContain("suggest_feature");
  });

  it("does not leak a task into another project's feature of the same id", () => {
    const project = createProject({ name: "Mine" });
    const other = createProject({ name: "Theirs" });
    const foreign = createFeature({ project_id: other.id, name: "Foreign" });

    const { task } = createSuggestedTask(project, { title: "t", description: "", feature: foreign.id });
    const fid = getTask(task.id)!.feature_id;
    expect(fid).not.toBe(foreign.id);
    // It became a new feature in THIS project rather than crossing the boundary.
    expect(getFeature(fid!)!.project_id).toBe(project.id);
  });

  it("leaves feature_id null when no feature is named", () => {
    const project = createProject({ name: "None" });
    const { task, text } = createSuggestedTask(project, { title: "t", description: "" });
    expect(getTask(task.id)!.feature_id).toBeNull();
    expect(text).not.toContain("Filed under");
  });

  it("never sets a branch from a planning turn", () => {
    const project = createProject({ name: "NoBranch" });
    const { feature } = createSuggestedFeature(project, { name: "F", context: "c" });
    expect(feature.branch).toBe("");
  });
});

// --------------------------------------------------------------- regression

describe("features — regression for projects that use none", () => {
  it("groups and prompts identically when no feature exists", () => {
    const project = createProject({ name: "Plain", context: "just the project" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });

    expect(listFeatures(project.id)).toEqual([]);
    const rows = listTasks(project.id);
    expect(rows.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(rows.every((t) => t.feature_id === null)).toBe(true);

    const prompt = buildProjectContext(project, getTask(a.id)!);
    expect(prompt).not.toContain("part of the feature");
    expect(prompt).not.toContain("Feature context:");
  });
});
