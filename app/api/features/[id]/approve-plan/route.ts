import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, updateTask, featureMembers } from "@/lib/store";
import { createFeatureBranch } from "@/lib/git";
import { ensureAutopilot, sweep } from "@/lib/autopilot";
import { resolveFeatures } from "@/lib/features";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Slugify a feature name into a branch-safe segment. Falls back to the id when a
// name is all punctuation, because "feature/" is not a branch.
const branchNameFor = (name: string, id: string) =>
  `feature/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || id}`;

/**
 * Gate 1 — the user approves the plan.
 *
 * Everything this does, the user could do by hand: accept each suggestion, cut
 * the integration branch, start the first task. It's one button because doing
 * it by hand twenty times is precisely the tedium being removed.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!resolveFeatures().autopilot)
    return NextResponse.json(
      { error: "Autopilot is not enabled on this instance (set ORCH_FEATURE_AUTOPILOT=1)." },
      { status: 400 }
    );

  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path)
    return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });

  const members = featureMembers(id);
  if (!members.length) return NextResponse.json({ error: "this feature has no tasks to approve" }, { status: 400 });

  // Cut the integration branch if the feature hasn't got one. This is not
  // optional: an empty features.branch means member tasks merge straight onto
  // the project branch, and landing unattended work there is exactly what the
  // second gate exists to prevent.
  let branch = feature.branch;
  if (!branch) {
    branch = branchNameFor(feature.name, id);
    const made = await createFeatureBranch(project.repo_path, branch, project.branch);
    if (!made)
      return NextResponse.json(
        { error: "could not create the integration branch — is the working directory a git repo with at least one commit?" },
        { status: 400 }
      );
    updateFeature(id, { branch, base_sha: made.sha });
  }

  // Accept the plan: every suggestion becomes committed work. A member the user
  // already accepted (or cancelled) is left exactly as it is.
  let accepted = 0;
  for (const t of members) {
    if (!t.suggested) continue;
    updateTask(t.id, { suggested: 0 });
    accepted++;
  }
  updateFeature(id, { autopilot: 1 });
  track("autopilot_plan_approved", { feature_id: id, project_id: project.id, tasks: members.length, accepted });

  // Arm the controller and kick the first pass. Detached — the sweep starts
  // turns, and a held HTTP request must never own multi-minute work.
  ensureAutopilot();
  void sweep(project.id).catch(() => {});

  return NextResponse.json({ ok: true, branch, accepted, total: members.length });
}
