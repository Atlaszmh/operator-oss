import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, featureMembers } from "@/lib/store";
import { createBranchPr, buildFeaturePrBody } from "@/lib/github";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Gate 2 — push the integration branch and open a PR against the project branch.
 *
 * Autopilot calls this same code when the last member lands; this route is the
 * manual equivalent, for a feature that was driven by hand or whose automatic
 * attempt failed. Idempotent, like the task-level one: running it again
 * re-pushes and returns the already-open PR.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path)
    return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch)
    return NextResponse.json({ error: "this feature has no integration branch to open a PR from" }, { status: 400 });

  const members = featureMembers(id);
  const res = await createBranchPr({
    cwd: project.repo_path,
    branch: feature.branch,
    baseBranch: project.branch,
    title: feature.name,
    body: buildFeaturePrBody({
      context: feature.context,
      description: feature.description,
      outcomes: members
        .filter((t) => t.status === "done")
        .map((t) => ({ title: t.title, outcome: t.outcome })),
      featureId: id,
    }),
  });

  if (res.ok && res.url) {
    updateFeature(id, { pr_url: res.url });
    track("feature_pr_created", { feature_id: id, project_id: project.id, existing: !!res.existing });
  }
  return NextResponse.json(res, { status: res.ok ? 200 : 409 });
}
