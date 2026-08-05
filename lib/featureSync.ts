import { landBranch, worktreeSyncStatus, fastForwardWorktree, prepareWorktreeMerge } from "./git";
import { listFeatures, listTasks, updateFeature, updateTask, taskBaseBranch } from "./store";
import { hasTurn } from "./abort";
import type { FeatureWithCounts, Project, Task } from "./types";

/**
 * Catch every live feature branch up with the project branch, the moment
 * anything lands there.
 *
 * WHY THIS EXISTS. A feature's integration branch forks once and is only
 * reconciled at ship time. Meanwhile every other feature that ships moves the
 * project branch underneath it. Nothing told it, so the divergence grew
 * unwatched until the user clicked Ship — and got a conflict built out of weeks
 * of work, on a branch whose sessions are long over.
 *
 * The real case this was written for: two features both added a render layer to
 * the same `app.stage.addChild(...)` call. One shipped; the other found out 7
 * commits and several days later. Reconciled at the moment of the landing it
 * would have been a one-line merge, against a diff the agent had just written.
 *
 * So: conflicts are not avoided, they are made SMALL and TIMELY. Every merge is
 * against one feature's worth of change instead of a release's worth.
 *
 * Cheap enough to run on every landing: `landBranch` merges at the object level
 * (`merge-tree --write-tree` + `commit-tree`) whenever git supports it, so a
 * clean catch-up never materializes a working tree. A feature already up to
 * date costs one `rev-list --count`.
 */

/** What one feature's catch-up did. `conflicts` is non-empty only when ok is false. */
export interface FeatureSyncResult {
  featureId: string;
  name: string;
  branch: string;
  ok: boolean;
  /** True when the branch was already up to date — nothing was merged. */
  alreadyMerged: boolean;
  conflicts: string[];
  error?: string;
}

/**
 * Which features a landing on the project branch should catch up.
 *
 * Excludes, in order: the feature that just shipped (its branch IS what landed);
 * features with no integration branch (their members already base off the
 * project branch, so there is nothing to catch up); shipped features (their
 * branch is history — re-merging it would resurrect a retired line); and
 * archived ones (deliberately out of the working set).
 */
export function featuresToSync(features: FeatureWithCounts[], exceptFeatureId?: string): FeatureWithCounts[] {
  return features.filter(
    (f) => f.branch !== "" && !f.archived && f.merged_at === 0 && f.id !== exceptFeatureId
  );
}

/**
 * Merge `project.branch` into every live feature branch. Never throws and never
 * fails its caller: a landing that already succeeded must not be reported as a
 * failure because a *different* feature could not be caught up.
 *
 * A conflict is parked on `features.sync_conflict` rather than resolved. There
 * is no worktree to resolve it in and no session that owns it (the whole point
 * is that this runs after someone else's merge), so it surfaces on the feature's
 * tile instead — where the person who owns that feature will see it. Any later
 * sync that succeeds clears it.
 */
export async function syncFeaturesToBase(
  project: Project,
  opts: { except?: string } = {}
): Promise<FeatureSyncResult[]> {
  if (!project.repo_path) return [];
  const targets = featuresToSync(listFeatures(project.id), opts.except);
  const results: FeatureSyncResult[] = [];

  for (const f of targets) {
    const base = { featureId: f.id, name: f.name, branch: f.branch };
    try {
      // Arguments swapped versus a ship: the FEATURE branch is the target here.
      const res = await landBranch({
        repoPath: project.repo_path,
        workBranch: project.branch,
        baseBranch: f.branch,
        message: `Merge ${project.branch} into ${f.branch}`,
      });

      // landBranch falls back to the repo's CURRENT branch when the target
      // doesn't exist, so a feature naming a deleted branch would merge main
      // into main and report a cheerful no-op. Catch it by what it actually
      // targeted: anything other than this feature's branch means the branch is
      // gone, and a feature that can never be caught up must say so rather than
      // report success forever.
      if (res.ok && res.targetBranch !== f.branch) {
        const note = `${f.branch} no longer exists in this repo, so it cannot be caught up with ${project.branch}.`;
        updateFeature(f.id, { sync_conflict: note });
        results.push({ ...base, ok: false, alreadyMerged: false, conflicts: [], error: note });
        continue;
      }

      if (res.ok) {
        // Clear a stale conflict note only when there was one — every write here
        // bumps updated_at, and a no-op sync should not look like activity.
        if (f.sync_conflict) updateFeature(f.id, { sync_conflict: "" });
        results.push({ ...base, ok: true, alreadyMerged: !!res.alreadyMerged, conflicts: [] });
        continue;
      }

      const conflicts = res.conflicts ?? [];
      const note = conflicts.length
        ? `${project.branch} conflicts with ${f.branch} in ${conflicts.length} file(s): ${conflicts.join(", ")}`
        : res.error || `could not merge ${project.branch} into ${f.branch}`;
      updateFeature(f.id, { sync_conflict: note });
      results.push({ ...base, ok: false, alreadyMerged: false, conflicts, error: note });
    } catch (e) {
      // A git failure on one feature must not abort the rest of the sweep.
      const note = `could not merge ${project.branch} into ${f.branch}: ${(e as Error).message}`;
      updateFeature(f.id, { sync_conflict: note });
      results.push({ ...base, ok: false, alreadyMerged: false, conflicts: [], error: note });
    }
  }
  return results;
}

/**
 * One line for the response text of whatever just landed, or "" when there was
 * nothing to say. Deliberately quiet about branches that were already current —
 * the useful signal is what MOVED and what is now stuck.
 */
export function summarizeSync(results: FeatureSyncResult[]): string {
  const moved = results.filter((r) => r.ok && !r.alreadyMerged);
  const stuck = results.filter((r) => !r.ok);
  const parts: string[] = [];
  if (moved.length) parts.push(`Caught up ${moved.map((r) => r.name).join(", ")}.`);
  if (stuck.length)
    parts.push(
      `${stuck.map((r) => r.name).join(", ")} now conflict${stuck.length === 1 ? "s" : ""} with the project branch — ` +
        `resolve ${stuck.length === 1 ? "it" : "them"} before shipping.`
    );
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// The same rule, one level down: a TASK branch following ITS base.
//
// Features drift from the project branch; sibling tasks drift from the feature
// branch, and for the identical reason — each forks once and only reconciles at
// merge time, while everything its siblings land moves the base underneath it.
// This half is where it hurts most: a feature runs several tasks at once by
// design (AUTOPILOT_CONCURRENCY), so the racing is not incidental, it IS the
// execution model.
// ---------------------------------------------------------------------------

/** What one worktree's catch-up did. `conflicts` non-empty ⇒ it could not be caught up. */
export interface CatchUpResult {
  caughtUp: boolean;
  behind: number;
  baseTip: string;
  conflicts: string[];
  /** The tree had uncommitted work, so it was deliberately left alone. */
  skippedDirty: boolean;
}

/**
 * Catch one task's worktree up to its base, by the only two routes that are
 * safe without a human: a fast-forward when the task has no divergent work, and
 * an ordinary merge when it does but `merge-tree` predicts no conflict.
 *
 * THE SECOND TIER IS THE WHOLE POINT, and the reason this is a shared function
 * rather than an inlined `fastForwardWorktree`. Fast-forward-only stops working
 * the instant a task commits anything — which is immediately — so a task drifts
 * one commit further behind for every sibling that lands while it works. The
 * conflict it eventually hits is the size of the whole race, not the size of
 * the change. `lib/runner.ts` learned this at turn start; autopilot's pre-gate
 * catch-up was still fast-forward-only, and silently discarded the boolean
 * saying it had failed, which is how a task reached its merge un-caught-up and
 * conflicted anyway.
 *
 * A dirty tree is left alone: prepareWorktreeMerge would commit an agent's
 * half-finished edits to get a clean tree, and that is not this function's call.
 */
export async function catchUpWorktree(project: Project, task: Task, base: string): Promise<CatchUpResult> {
  const none: CatchUpResult = { caughtUp: false, behind: 0, baseTip: "", conflicts: [], skippedDirty: false };
  if (!task.worktree_path || !task.work_branch || !project.repo_path) return none;
  try {
    const s = await worktreeSyncStatus({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: base,
    });
    if (s.behind === 0) return { ...none, baseTip: s.baseTip };
    if (s.isDirty) return { ...none, behind: s.behind, baseTip: s.baseTip, skippedDirty: true };

    if (s.canFastForward) {
      const ok = await fastForwardWorktree(task.worktree_path, base);
      return { caughtUp: ok, behind: s.behind, baseTip: s.baseTip, conflicts: [], skippedDirty: false };
    }
    if (s.clean) {
      const prep = await prepareWorktreeMerge({
        repoPath: project.repo_path,
        worktreePath: task.worktree_path,
        baseBranch: base,
        message: `Sync ${base} into ${task.title} (orchestrator task ${task.id})`,
      });
      // prep.ok && !prep.clean means merge-tree's prediction was wrong at the
      // margin and the worktree now holds markers — report them rather than
      // pretending the catch-up worked.
      return {
        caughtUp: prep.ok && prep.clean,
        behind: s.behind,
        baseTip: s.baseTip,
        conflicts: prep.ok && prep.clean ? [] : prep.conflicts ?? [],
        skippedDirty: false,
      };
    }
    // merge-tree already predicts a conflict — don't touch the tree at all.
    return { caughtUp: false, behind: s.behind, baseTip: s.baseTip, conflicts: s.conflicts ?? [], skippedDirty: false };
  } catch {
    // A git hiccup must never break the caller — the catch-up is best effort.
    return none;
  }
}

export interface TaskSyncResult {
  taskId: string;
  title: string;
  caughtUp: boolean;
  behind: number;
  conflicts: string[];
}

/**
 * After a task lands on `baseBranch`, catch every OTHER idle worktree on that
 * same base up to it — immediately, rather than at each sibling's next turn.
 *
 * Skips anything with a live turn: the agent is editing those files right now,
 * and moving the tree underneath it would corrupt work in progress. Those catch
 * up at their next turn start (lib/runner.ts) and again before their gate
 * (lib/autopilot.ts), both of which now use the same ladder as this.
 *
 * A sibling that genuinely conflicts is left untouched and reported, not forced:
 * there IS a session that owns it, so the existing conflict flow can hand it to
 * that agent with full context — unlike a feature-level conflict, which has
 * nobody.
 */
export async function syncTasksToBase(
  project: Project,
  baseBranch: string,
  opts: { except?: string } = {}
): Promise<TaskSyncResult[]> {
  if (!project.repo_path || !baseBranch) return [];
  const siblings = listTasks(project.id).filter(
    (t) =>
      t.id !== opts.except &&
      !!t.worktree_path &&
      !!t.work_branch &&
      !t.running &&
      !hasTurn(t.id) &&
      t.status !== "done" &&
      t.status !== "cancelled" &&
      taskBaseBranch(t, project) === baseBranch
  );

  const results: TaskSyncResult[] = [];
  for (const t of siblings) {
    const r = await catchUpWorktree(project, t, baseBranch);
    if (r.caughtUp && r.baseTip) updateTask(t.id, { base_sha: r.baseTip });
    results.push({ taskId: t.id, title: t.title, caughtUp: r.caughtUp, behind: r.behind, conflicts: r.conflicts });
  }
  return results;
}
