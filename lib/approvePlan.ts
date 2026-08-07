// Gate 1 as a callable: the approve-plan treatment (cut the integration branch,
// accept the plan's suggestions, arm autopilot), extracted from the route so
// feature chaining can apply it without an HTTP request. Two callers:
//   - POST /api/features/[id]/approve-plan (the button)
//   - kickoffDependents() below, fired from both writers of features.merged_at
//     (the ship route, and reconcileFeatureBranch's lost-stamp heal)
import { getFeature, getProject, updateFeature, updateTask, featureMembers, getFeatureDependents, featureDepsSatisfied } from "./store";
import { createFeatureBranch } from "./git";
import { ensureAutopilot, sweep } from "./autopilot";
import { resolveFeatures } from "./features";
import { track } from "./analytics";
import type { Feature, Project } from "./types";

// Slugify a feature name into a branch-safe segment. Falls back to the id when a
// name is all punctuation, because "feature/" is not a branch.
const branchNameFor = (name: string, id: string) =>
  `feature/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || id}`;

export type ApprovePlanResult =
  | { ok: true; outcome: "did-work" | "already-armed"; branch: string; accepted: number; total: number }
  | { ok: false; outcome: "flag-off" | "no-repo" | "branch-failed"; error: string };

/**
 * Everything this does, the user could do by hand: accept each suggestion, cut
 * the integration branch, start the first task. Idempotency: already armed ⇒
 * skip entirely; a pre-existing branch (cut via POST /branch) ⇒ skip only the
 * cut and still accept + arm. The flag check lives HERE, not in the route, so
 * chain kickoff can never arm features on an instance whose operator disabled
 * autopilot.
 */
export async function approvePlan(feature: Feature, project: Project): Promise<ApprovePlanResult> {
  if (!resolveFeatures().autopilot)
    return { ok: false, outcome: "flag-off", error: "Autopilot is not enabled on this instance (set ORCH_FEATURE_AUTOPILOT=1)." };
  if (!project.repo_path)
    return { ok: false, outcome: "no-repo", error: "this project has no working directory" };
  // Skip-entirely on armed also skips the ensureAutopilot()/sweep() re-kick the
  // old route performed on a re-click. Deliberate: the always-open /api/events
  // subscription and the safety sweep both re-arm the controller, and a chain
  // kickoff must not re-drive a feature that's already running.
  if (feature.autopilot)
    return { ok: true, outcome: "already-armed", branch: feature.branch, accepted: 0, total: featureMembers(feature.id).length };

  // An empty feature is allowed: arming BEFORE the plan exists is the kickoff
  // flow (see driveFeature step 0).
  const members = featureMembers(feature.id);

  // Cut the integration branch if the feature hasn't got one. Not optional: an
  // empty features.branch means member tasks merge straight onto the project
  // branch, which is exactly what the second gate exists to prevent.
  let branch = feature.branch;
  if (!branch) {
    branch = branchNameFor(feature.name, feature.id);
    const made = await createFeatureBranch(project.repo_path, branch, project.branch);
    if (!made)
      return {
        ok: false,
        outcome: "branch-failed",
        error: "could not create the integration branch — is the working directory a git repo with at least one commit?",
      };
    updateFeature(feature.id, { branch, base_sha: made.sha });
  }

  // Accept the plan: every suggestion becomes committed work. A member the user
  // already accepted (or cancelled) is left exactly as it is.
  let accepted = 0;
  for (const t of members) {
    if (!t.suggested) continue;
    updateTask(t.id, { suggested: 0 });
    accepted++;
  }
  updateFeature(feature.id, { autopilot: 1 });
  track("autopilot_plan_approved", { feature_id: feature.id, project_id: project.id, tasks: members.length, accepted });

  // Arm the controller and kick the first pass. Detached — a caller must never
  // own multi-minute work.
  ensureAutopilot();
  void sweep(project.id).catch(() => {});

  return { ok: true, outcome: "did-work", branch, accepted, total: members.length };
}

export interface KickoffResult {
  featureId: string;
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * The chain: `featureId` just shipped — give every dependent whose deps have ALL
 * now shipped the approve-plan treatment. The dependency edge is the approval
 * marker (see the spec): it only exists because the planner or user deliberately
 * chained, and approving the head approved the chain. Never throws; per-
 * dependent failures are returned, a flag-off no-op is just logged.
 */
export async function kickoffDependents(featureId: string): Promise<KickoffResult[]> {
  const results: KickoffResult[] = [];
  for (const depId of getFeatureDependents(featureId)) {
    const f = getFeature(depId);
    // merged_at too, not just archived: shipping sets both, but Restore clears
    // only `archived` — a shipped feature the user restored (to file a
    // follow-up) with a leftover chain edge must not be silently re-armed and
    // auto-started when that edge's predecessor ships. Guarded here rather
    // than in approvePlan so a deliberate manual re-approve still works.
    if (!f || f.archived || f.autopilot || f.merged_at > 0) continue;
    if (!featureDepsSatisfied(f.id)) continue;
    const project = getProject(f.project_id);
    if (!project) continue;
    try {
      const res = await approvePlan(f, project);
      if (res.ok) results.push({ featureId: f.id, name: f.name, ok: true });
      else if (res.outcome === "flag-off") console.log(`[chain] not kicking off "${f.name}": autopilot is not enabled on this instance`);
      else results.push({ featureId: f.id, name: f.name, ok: false, error: res.error });
    } catch (e) {
      results.push({ featureId: f.id, name: f.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
