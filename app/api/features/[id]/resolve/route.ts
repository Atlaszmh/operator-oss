import { NextResponse } from "next/server";
import { getFeature, getProject, getTask, updateTask, updateFeature, listFeatures } from "@/lib/store";
import { worktreeSyncStatus, landBranch } from "@/lib/git";
import { fileConflictResolutionTask } from "@/lib/featureSync";
import { startInitialTurn } from "@/lib/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Resolve a feature-level conflict WITH THE MACHINE, instead of the old dead
// end ("resolve it in your own checkout"). The resolution is an ordinary member
// task whose worktree is cut from the feature branch, so the entire existing
// flow applies — transcript, diff review, gates, merge. When that task merges,
// the feature branch contains the project branch, and the next sync clears the
// parked note on its own.
//
// Explicitly clicked, so unlike the auto-filed suggestion this one starts NOW:
// the user asked for resolution, not for a suggestion to approve.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch) return NextResponse.json({ error: "this feature has no integration branch" }, { status: 400 });

  // A SHIPPED feature's note means the opposite problem: commits landed on the
  // branch after it shipped, and the remedy is Ship again — landing them on the
  // project branch. "Resolving" here would merge the project branch INTO a
  // retired line nothing will ever sync again, clear the warning, and leave the
  // stranded commits exactly as stranded. Refuse and say what to do instead.
  if (feature.merged_at > 0)
    return NextResponse.json(
      { error: `${feature.branch} already shipped. The note means work landed on it afterwards — use Ship again to land that work on ${project.branch}; there is no conflict to resolve.` },
      { status: 409 }
    );

  const s = await worktreeSyncStatus({
    repoPath: project.repo_path,
    workBranch: feature.branch,
    baseBranch: project.branch,
  }).catch(() => null);
  if (!s) return NextResponse.json({ error: `could not read ${feature.branch}` }, { status: 500 });

  // A missing branch comes back as the zeroed status, which reads exactly like
  // "up to date" — and clearing the parked "branch no longer exists" note on
  // that basis would erase a true warning and report a nonexistent branch as
  // caught up. Same !baseTip discrimination reconcileFeatureBranch uses.
  if (!s.baseTip)
    return NextResponse.json(
      { error: `${feature.branch} no longer exists in this repo — there is nothing to resolve. Point the feature at a real branch, or stop using an integration branch.` },
      { status: 409 }
    );

  // Not actually conflicted (the note may be stale, or the user beat us to it):
  // do the sync right here rather than bounce them to a second button.
  if (s.behind === 0 || s.clean) {
    if (s.behind > 0) {
      const res = await landBranch({
        repoPath: project.repo_path,
        workBranch: project.branch,
        baseBranch: feature.branch,
        message: `Merge ${project.branch} into ${feature.branch}`,
      });
      if (!res.ok)
        return NextResponse.json({ error: res.error ?? "sync failed", conflicts: res.conflicts ?? [] }, { status: 409 });
    }
    if (feature.sync_conflict) updateFeature(feature.id, { sync_conflict: "" });
    return NextResponse.json({ ok: true, taskId: null, text: `${feature.branch} is caught up with ${project.branch} — no conflict left to resolve.` });
  }

  const withCounts = listFeatures(project.id).find((f) => f.id === id);
  const { task, existing } = fileConflictResolutionTask(project, withCounts ?? { id: feature.id, branch: feature.branch }, s.conflicts);

  // A live resolution task is already on it — jump there instead of stacking a
  // second session onto the same worktree.
  if (existing && (task.running || task.started)) {
    return NextResponse.json({ ok: true, taskId: task.id, text: `A resolution task is already working on this.` });
  }

  // The click is the approval: promote the suggestion and start it.
  updateTask(task.id, { suggested: 0 });
  const launch = await startInitialTurn(getTask(task.id)!, project);
  if (!launch.ok) return NextResponse.json({ error: launch.error, taskId: task.id }, { status: launch.status });

  return NextResponse.json({
    ok: true,
    taskId: task.id,
    text: `Resolving ${s.conflicts.length} conflicted file${s.conflicts.length === 1 ? "" : "s"} in a task — review its diff, then merge it into ${feature.branch}.`,
  });
}
