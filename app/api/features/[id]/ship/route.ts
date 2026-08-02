import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, featureUnfinishedTasks } from "@/lib/store";
import { mergeFeature } from "@/lib/git";

export const dynamic = "force-dynamic";

// Land the whole feature on the project branch as one unit. The unfinished-task
// check is advisory and reported in the response rather than enforced — the
// user may well know those tasks are abandoned, and a hard block would leave no
// way to ship without cancelling work they'd rather keep listed.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch) return NextResponse.json({ error: "this feature has no integration branch" }, { status: 400 });

  const unfinished = featureUnfinishedTasks(feature.id);
  const res = await mergeFeature({
    repoPath: project.repo_path,
    featureBranch: feature.branch,
    baseBranch: project.branch,
    message: `Merge feature ${feature.name} (${feature.branch}) into ${project.branch}`,
  });

  if (!res.ok) {
    return NextResponse.json(
      {
        error: res.conflicts?.length
          ? `${feature.branch} conflicts with ${project.branch} in ${res.conflicts.length} file(s). Sync the feature first, or resolve them in your own checkout.`
          : res.error,
        conflicts: res.conflicts ?? [],
      },
      { status: 409 }
    );
  }

  // Only stamp merged_at when commits actually landed — a re-ship of an
  // already-merged branch shouldn't reset the date it originally shipped.
  if (!res.alreadyMerged) updateFeature(feature.id, { merged_at: Date.now() });

  const tail = unfinished.length
    ? ` ${unfinished.length} task${unfinished.length === 1 ? " is" : "s are"} still unfinished, so only work already merged into ${feature.branch} landed.`
    : "";
  return NextResponse.json({
    ok: true,
    alreadyMerged: !!res.alreadyMerged,
    text: res.alreadyMerged
      ? `${feature.branch} was already merged into ${res.targetBranch}.`
      : `Shipped ${feature.name}: merged ${feature.branch} into ${res.targetBranch}.${tail}`,
  });
}
