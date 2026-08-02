import { NextResponse } from "next/server";
import {
  getFeature,
  getProject,
  updateFeature,
  featureTasksWithWorktrees,
  featureUnfinishedTasks,
} from "@/lib/store";
import { createFeatureBranch, worktreeSyncStatus } from "@/lib/git";

export const dynamic = "force-dynamic";

// Default branch name for a feature: orch/feat/<slug>, matching the orch/<id>
// convention task branches already use.
function branchNameFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `orch/feat/${slug || "feature"}`;
}

async function load(id: string) {
  const feature = getFeature(id);
  if (!feature) return null;
  const project = getProject(feature.project_id);
  if (!project) return null;
  return { feature, project };
}

// Divergence of the integration branch from the project branch, plus the two
// guard sets the UI needs to explain what it can and can't do right now.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await load(id);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { feature, project } = found;

  const base = {
    branch: feature.branch,
    baseBranch: project.branch,
    merged_at: feature.merged_at,
    worktreeBlockers: featureTasksWithWorktrees(feature.id),
    unfinished: featureUnfinishedTasks(feature.id),
  };
  if (!feature.branch || !project.repo_path) return NextResponse.json(base);

  // No worktreePath: a feature branch has none, and every field except the
  // dirty check is pure branch arithmetic (see worktreeSyncStatus).
  const status = await worktreeSyncStatus({
    repoPath: project.repo_path,
    workBranch: feature.branch,
    baseBranch: project.branch,
  }).catch(() => null);

  return NextResponse.json({
    ...base,
    behind: status?.behind ?? 0,
    ahead: status?.ahead ?? 0,
    canFastForward: status?.canFastForward ?? false,
    clean: status?.clean ?? true,
    conflicts: status?.conflicts ?? [],
  });
}

// Start using an integration branch. Creates it at the tip of the project
// branch (or attaches to an existing branch of the same name) and records the
// fork point.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await load(id);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { feature, project } = found;
  if (!project.repo_path)
    return NextResponse.json({ error: "this project has no working directory, so it has no branches" }, { status: 400 });

  // THE guard. Existing worktrees were cut from a different base; re-pointing
  // the feature would leave their diff base and merge target disagreeing, which
  // stays invisible until a merge quietly produces the wrong result.
  const blockers = featureTasksWithWorktrees(feature.id);
  if (blockers.length)
    return NextResponse.json(
      {
        error:
          `${blockers.length} task${blockers.length === 1 ? "" : "s"} in this feature already have a worktree cut from ` +
          `${project.branch} (${blockers.map((t) => t.title).join(", ")}). Merge or delete ${blockers.length === 1 ? "it" : "them"} first — ` +
          `re-pointing a live worktree would silently break its diff and merge.`,
        worktreeBlockers: blockers,
      },
      { status: 409 }
    );

  let name = "";
  try {
    const body = await req.json();
    name = typeof body?.branch === "string" ? body.branch.trim() : "";
  } catch {
    /* no body — use the default name */
  }
  const branch = name || branchNameFor(feature.name);

  const res = await createFeatureBranch(project.repo_path, branch, project.branch).catch(() => null);
  if (!res) return NextResponse.json({ error: `could not create the branch ${branch}` }, { status: 400 });

  // merged_at resets: this is a fresh (or re-attached) branch, not the one that
  // was shipped before.
  const updated = updateFeature(feature.id, { branch, base_sha: res.sha, merged_at: 0 });
  return NextResponse.json({
    ok: true,
    feature: updated,
    text: res.created
      ? `Created ${branch} from ${project.branch}. New tasks in this feature will branch off it and merge back into it.`
      : `Attached to the existing branch ${branch}. New tasks in this feature will branch off it and merge back into it.`,
  });
}

// Stop using an integration branch. The branch itself is LEFT IN THE REPO on
// purpose: it may hold merged task commits that aren't on the project branch
// yet, and deleting it here would discard them with no warning.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await load(id);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { feature, project } = found;

  const blockers = featureTasksWithWorktrees(feature.id);
  if (blockers.length)
    return NextResponse.json(
      {
        error:
          `${blockers.length} task${blockers.length === 1 ? "" : "s"} still have a worktree on ${feature.branch} ` +
          `(${blockers.map((t) => t.title).join(", ")}). Merge or delete ${blockers.length === 1 ? "it" : "them"} first.`,
        worktreeBlockers: blockers,
      },
      { status: 409 }
    );

  const updated = updateFeature(feature.id, { branch: "", base_sha: "" });
  return NextResponse.json({
    ok: true,
    feature: updated,
    text: `New tasks in this feature will branch off ${project.branch} again. ${feature.branch} was left in the repo — delete it yourself if it holds nothing you need.`,
  });
}
