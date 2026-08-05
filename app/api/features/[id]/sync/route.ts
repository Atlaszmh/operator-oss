import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature } from "@/lib/store";
import { landBranch } from "@/lib/git";

export const dynamic = "force-dynamic";

// Pull the project branch INTO the feature's integration branch, so a
// long-lived feature doesn't drift until the ship merge has to reconcile
// everything at once. Same landBranch helper as every other merge, arguments
// swapped: the feature branch is the target here, not the source.
//
// ponytail: no conflict-resolution flow at the feature level — a conflicted
// sync reports the paths and stops. There is no worktree to resolve them in and
// no session to hand them to, and conflicts here should be rare (every task
// merged into this branch cleanly, so the only divergence is the project branch
// moving). Upgrade path if that stops being true: cut a temporary worktree on
// the feature branch and run the existing prepareWorktreeMerge → AI-resolution
// → completeWorktreeMerge flow against it, exactly as a task does.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch) return NextResponse.json({ error: "this feature has no integration branch" }, { status: 400 });

  const res = await landBranch({
    repoPath: project.repo_path,
    workBranch: project.branch,
    baseBranch: feature.branch,
    message: `Merge ${project.branch} into ${feature.branch}`,
  });

  if (!res.ok) {
    const note = res.conflicts?.length
      ? `${project.branch} conflicts with ${feature.branch} in ${res.conflicts.length} file(s): ${res.conflicts.join(", ")}`
      : res.error || `could not merge ${project.branch} into ${feature.branch}`;
    // Park it in the same place the automatic catch-up does, so the tile tells
    // the same story whichever path found the conflict.
    updateFeature(feature.id, { sync_conflict: note });
    return NextResponse.json(
      {
        error: res.conflicts?.length
          ? `${project.branch} conflicts with ${feature.branch} in ${res.conflicts.length} file(s). Resolve them in your own checkout, then sync again.`
          : res.error,
        conflicts: res.conflicts ?? [],
      },
      { status: 409 }
    );
  }
  // Succeeded — whatever the last attempt parked is stale now.
  if (feature.sync_conflict) updateFeature(feature.id, { sync_conflict: "" });
  return NextResponse.json({
    ok: true,
    text: res.alreadyMerged
      ? `${feature.branch} was already up to date with ${project.branch}.`
      : `Merged ${project.branch} into ${feature.branch}.`,
  });
}
