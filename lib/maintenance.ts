// Background housekeeping the user shouldn't have to remember.
//
// Everything here has a manual equivalent in the app already — this is the timer
// that stops "someone will click it eventually" from meaning "never".

import { listPrunableWorktrees, updateTask, getProject } from "./store";
import { removeWorktree, worktreePruneSafety } from "./git";
import { hasTurn } from "./abort";
import { WORKTREE_PRUNE_AFTER_MS } from "./config";

declare global {
  // eslint-disable-next-line no-var
  var __orchLastWorktreePrune: number | undefined;
}

// The heartbeat ticks every minute; scanning every worktree that often would be
// pure waste for a job whose input changes on the scale of days.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Remove the worktrees of tasks that merged long enough ago to be finished with.
 *
 * The same safety checks the maintenance panel runs, in the same order, because
 * they are the ones that matter: a task can be "merged" and STILL hold work
 * (uncommitted edits, or commits added after the merge), and reclaiming that
 * would destroy it. worktreePruneSafety is the authority; anything it declines
 * is left alone and shows up in the panel as before.
 *
 * The branch is kept, so the task stays reopenable and its diff base survives —
 * this reclaims a checkout, not history.
 *
 * Returns the number pruned. Best-effort throughout: one project with a broken
 * repo path must not stop the rest.
 */
export async function sweepMergedWorktrees(now = Date.now()): Promise<number> {
  if (!(WORKTREE_PRUNE_AFTER_MS > 0)) return 0;
  if (global.__orchLastWorktreePrune && now - global.__orchLastWorktreePrune < PRUNE_INTERVAL_MS) return 0;
  global.__orchLastWorktreePrune = now;

  let pruned = 0;
  for (const row of listPrunableWorktrees()) {
    try {
      if (!row.merged_at || now - row.merged_at < WORKTREE_PRUNE_AFTER_MS) continue;
      // Never yank a checkout out from under a live turn — a reopened task runs
      // in the very worktree this would delete.
      if (hasTurn(row.id)) continue;
      const project = getProject(row.project_id);
      if (!project?.repo_path) continue;

      const safety = await worktreePruneSafety({
        repoPath: project.repo_path,
        worktreePath: row.worktree_path,
        workBranch: row.work_branch,
        baseBranch: project.branch,
      });
      if (!safety.safe) continue;

      await removeWorktree(project.repo_path, row.worktree_path, row.work_branch, { keepBranch: true });
      updateTask(row.id, { worktree_path: "" });
      pruned++;
    } catch (e) {
      console.warn(`[maintenance] could not prune worktree for task ${row.id}:`, (e as Error).message);
    }
  }
  if (pruned) console.log(`[maintenance] pruned ${pruned} merged worktree(s)`);
  return pruned;
}
