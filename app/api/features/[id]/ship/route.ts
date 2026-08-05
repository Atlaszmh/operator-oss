import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, featureUnfinishedTasks } from "@/lib/store";
import { mergeFeature } from "@/lib/git";
import { syncFeaturesToBase, summarizeSync, publishProjectBranch } from "@/lib/featureSync";
import { runFeatureGate, featureGateFailure } from "@/lib/gates";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// Land the whole feature on the project branch as one unit. The unfinished-task
// check is advisory and reported in the response rather than enforced — the
// user may well know those tasks are abandoned, and a hard block would leave no
// way to ship without cancelling work they'd rather keep listed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch) return NextResponse.json({ error: "this feature has no integration branch" }, { status: 400 });

  // Prove the ASSEMBLED branch runs before it touches the project branch. Until
  // this existed the only check here was git's, which reports overlapping edits
  // and nothing else — so a feature whose members were each individually green
  // could merge cleanly and still be broken. `?force=1` is the deliberate
  // override for a user who has looked and disagrees.
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force) {
    const gate = await runFeatureGate(project, feature);
    if (!gate.ok) {
      return NextResponse.json(
        { error: featureGateFailure(feature, project, gate), gateFailed: true, inconclusive: !!gate.inconclusive },
        { status: 409 }
      );
    }
  }

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
  //
  // Shipping is also the moment the feature leaves the working set, so it
  // archives itself in the same write: the Archived section is where it stays
  // reachable (and restorable) instead of sitting at the top of the task list
  // forever. Guarded by alreadyMerged for the same reason merged_at is —
  // re-shipping must not un-do a deliberate Restore.
  if (!res.alreadyMerged) updateFeature(feature.id, { merged_at: Date.now(), archived: 1 });

  // The project branch just moved, so every other live feature is now behind by
  // exactly this feature. Catch them up HERE, at the landing, while the conflict
  // (if any) is one feature wide and the sessions that caused it are still warm.
  // Left until each feature's own ship, this is the divergence that turns a
  // one-line reconciliation into a multi-week merge. Never fails the ship: the
  // merge already succeeded, and another feature's branch is not this one's
  // problem to report as an error.
  const synced = res.alreadyMerged ? [] : await syncFeaturesToBase(project, { except: feature.id });
  const syncNote = summarizeSync(synced);
  // Publish what landed, when the instance is configured to (off by default).
  // After the local catch-ups: a push that hangs must not delay reconciling the
  // branches this merge just moved underneath.
  const published = res.alreadyMerged ? { pushed: false, note: "" } : await publishProjectBranch(project);

  const tail = unfinished.length
    ? ` ${unfinished.length} task${unfinished.length === 1 ? " is" : "s are"} still unfinished, so only work already merged into ${feature.branch} landed.`
    : "";
  return NextResponse.json({
    ok: true,
    alreadyMerged: !!res.alreadyMerged,
    synced,
    pushed: published.pushed,
    text: res.alreadyMerged
      ? `${feature.branch} was already merged into ${res.targetBranch}.`
      : `Shipped ${feature.name}: merged ${feature.branch} into ${res.targetBranch}.${tail}` +
        `${syncNote ? ` ${syncNote}` : ""}${published.note ? ` ${published.note}` : ""}`,
  });
}
