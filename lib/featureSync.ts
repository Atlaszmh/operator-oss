import { landBranch } from "./git";
import { listFeatures, updateFeature } from "./store";
import type { FeatureWithCounts, Project } from "./types";

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
