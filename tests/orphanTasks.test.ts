import { describe, expect, it } from "vitest";
import { createSuggestedTask } from "@/lib/agentTools";
import { createProject, createFeature, createTask, getTask, updateTask } from "@/lib/store";
import { sweepMergedWorktrees } from "@/lib/maintenance";
import { ensureWorktree } from "@/lib/git";
import { commitFile, git, makeRepo, uid } from "./helpers";
import fs from "node:fs";

describe("suggest_task feature inheritance", () => {
  // Autopilot only ever walks feature members (sweepOnce → driveFeature →
  // featureMembers), so a task filed with no feature is one nothing will pick
  // up. A blocker filed that way sat untouched in the tray while the work it
  // blocked waited on it.
  it("files follow-up work into the calling task's feature", () => {
    const project = createProject({ name: `Inherit-${uid()}` });
    const feature = createFeature({ project_id: project.id, name: "Parent feature" });

    const { task, text } = createSuggestedTask(project, {
      title: "Something the agent noticed while working",
      description: "",
      inheritFeatureId: feature.id,
    });

    expect(getTask(task.id)!.feature_id).toBe(feature.id);
    expect(text).toContain("Parent feature");
  });

  it("an explicit feature still wins over the inherited one", () => {
    const project = createProject({ name: `Inherit-${uid()}` });
    const parent = createFeature({ project_id: project.id, name: "Parent" });
    const other = createFeature({ project_id: project.id, name: "Elsewhere" });

    const { task } = createSuggestedTask(project, {
      title: "Belongs somewhere else",
      description: "",
      feature: "Elsewhere",
      inheritFeatureId: parent.id,
    });

    expect(getTask(task.id)!.feature_id).toBe(other.id);
  });

  it("a caller with no feature still files a loose task", () => {
    const project = createProject({ name: `Inherit-${uid()}` });
    const { task } = createSuggestedTask(project, {
      title: "Standalone errand",
      description: "",
      inheritFeatureId: null,
    });
    expect(getTask(task.id)!.feature_id).toBeNull();
  });

  it("ignores a feature id that no longer exists", () => {
    const project = createProject({ name: `Inherit-${uid()}` });
    const { task } = createSuggestedTask(project, {
      title: "Orphan parent",
      description: "",
      inheritFeatureId: "does-not-exist",
    });
    expect(getTask(task.id)!.feature_id).toBeNull();
  });
});

describe("duplicate-brief warning", () => {
  // Two tasks were once filed with the same brief, both built to completion by
  // different sessions, and both reached the merge queue with incompatible
  // takes on the same change.
  it("warns when an open task already has the same title", () => {
    const project = createProject({ name: `Dupe-${uid()}` });
    const first = createTask({ project_id: project.id, title: "Price a bumper hit above a plain peg hit" });

    const { text } = createSuggestedTask(project, {
      title: "price a bumper hit ABOVE a plain peg hit",
      description: "",
    });

    expect(text).toContain("already open with the same title");
    expect(text).toContain(first.id);
  });

  it("says nothing when the earlier task is already done", () => {
    const project = createProject({ name: `Dupe-${uid()}` });
    const done = createTask({ project_id: project.id, title: "Wire up the payout screen properly" });
    updateTask(done.id, { status: "done" });

    const { text } = createSuggestedTask(project, {
      title: "Wire up the payout screen properly",
      description: "",
    });
    expect(text).not.toContain("already open");
  });

  it("does not warn across projects", () => {
    const a = createProject({ name: `Dupe-A-${uid()}` });
    const b = createProject({ name: `Dupe-B-${uid()}` });
    createTask({ project_id: a.id, title: "A sufficiently long shared title" });

    const { text } = createSuggestedTask(b, { title: "A sufficiently long shared title", description: "" });
    expect(text).not.toContain("already open");
  });

  it("ignores titles too short to mean anything", () => {
    const project = createProject({ name: `Dupe-${uid()}` });
    createTask({ project_id: project.id, title: "fix" });
    const { text } = createSuggestedTask(project, { title: "fix", description: "" });
    expect(text).not.toContain("already open");
  });
});

describe("sweepMergedWorktrees", () => {
  async function mergedTaskWithWorktree(ageMs: number) {
    const repo = await makeRepo();
    const project = createProject({ name: `Prune-${uid()}` });
    const p = (await import("@/lib/store")).updateProject(project.id, { repo_path: repo, branch: "main" })!;
    const task = createTask({ project_id: p.id, title: "Merged long ago" });
    const wt = await ensureWorktree(repo, task.id);
    if (!wt) throw new Error("no worktree");
    // Its work is genuinely in main, which is what makes it safe to reclaim.
    await git(repo, "merge", "--no-ff", "-m", "land it", wt.branch);
    updateTask(task.id, {
      worktree_path: wt.path,
      work_branch: wt.branch,
      base_sha: wt.baseSha,
      merged_at: Date.now() - ageMs,
    });
    return { repo, project: p, task, wt };
  }

  it("reclaims a worktree whose task merged long ago, keeping the branch", async () => {
    const { repo, task, wt } = await mergedTaskWithWorktree(30 * 24 * 60 * 60 * 1000);

    expect(await sweepMergedWorktrees()).toBeGreaterThan(0);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(getTask(task.id)!.worktree_path).toBe("");
    // Branch kept: the task stays reopenable and its diff base survives.
    expect(await git(repo, "rev-parse", "--verify", wt.branch)).toBeTruthy();
  }, 30_000);

  it("leaves a recently merged worktree alone", async () => {
    const { task, wt } = await mergedTaskWithWorktree(60 * 1000);
    // Reset the hourly throttle so this run is not skipped for the wrong reason.
    global.__orchLastWorktreePrune = undefined;

    await sweepMergedWorktrees();

    expect(fs.existsSync(wt.path)).toBe(true);
    expect(getTask(task.id)!.worktree_path).toBe(wt.path);
  }, 30_000);

  it("refuses to reclaim a worktree still holding unmerged work", async () => {
    const { repo, task, wt } = await mergedTaskWithWorktree(30 * 24 * 60 * 60 * 1000);
    // Merged once, then grew a commit that never landed — the case that would
    // destroy work if "merged_at is set" were the whole test.
    await commitFile(wt.path, "after.txt", "written after the merge\n", "more work");
    global.__orchLastWorktreePrune = undefined;

    await sweepMergedWorktrees();

    expect(fs.existsSync(wt.path)).toBe(true);
    expect(getTask(task.id)!.worktree_path).toBe(wt.path);
    expect(await git(repo, "rev-parse", "--verify", wt.branch)).toBeTruthy();
  }, 30_000);
});
