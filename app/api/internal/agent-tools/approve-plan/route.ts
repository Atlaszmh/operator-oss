import { NextResponse, type NextRequest } from "next/server";
import { getProject, findFeature, getFeature, featureDepsSatisfied, getFeatureDeps } from "@/lib/store";
import { approvePlan } from "@/lib/approvePlan";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Gate 1, for a caller with no browser.
//
// `POST /api/features/[id]/approve-plan` is the button, and it is unreachable to
// automation on an Access-gated instance: Access gates every route including
// localhost, and the only paths that take the instance SERVICE_TOKEN instead are
// these agent-tool ones (middleware.ts, isAgentToolPath). So a session that had
// just filed a whole plan through suggest-feature/suggest-task could not start
// it — the plan sat in the tray until someone opened the UI. This is the same
// approvePlan() the button calls, reached the way the filing calls already are.
//
// It does NOT weaken the gate it belongs to. Approving is still an explicit,
// separate act a caller has to choose; what changed is that the caller may be a
// script the user is talking to rather than the user's mouse.
//
// `feature` is a NAME (or key, or id) exactly like suggest-task's, resolved by
// findFeature. Unlike suggest-task it never auto-creates: approving a feature
// that isn't there is a typo, and arming an empty auto-created one would start a
// branch with nothing in it.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; feature?: string; featureId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const ref = (body.featureId ?? body.feature ?? "").trim();
  if (!ref) return NextResponse.json({ error: "feature is required (name, key, or id)" }, { status: 400 });
  const feature = findFeature(project.id, ref);
  if (!feature) return NextResponse.json({ error: `no feature "${ref}" in this project` }, { status: 404 });

  // A chained feature approves itself when its predecessors ship — that edge IS
  // the approval (see kickoffDependents). Approving it now would cut its branch
  // from a base that does not contain the work it was chained behind, which is
  // the whole thing the chain exists to prevent. A human clicking the button can
  // still override; a script looping over a filed plan almost never means to, so
  // this answers 200 rather than erroring — "approve the plan" over a chain is a
  // complete, correct outcome, not a partial failure.
  if (!featureDepsSatisfied(feature.id)) {
    const waitingOn = getFeatureDeps(feature.id)
      .map((id) => getFeature(id)?.name)
      .filter(Boolean)
      .join(", ");
    return NextResponse.json({
      ok: true,
      outcome: "chained",
      id: feature.id,
      name: feature.name,
      text: `"${feature.name}" starts automatically once ${waitingOn || "the features it depends on"} ship — left as it is.`,
    });
  }

  const res = await approvePlan(feature, project);
  if (!res.ok) return NextResponse.json({ error: res.error, outcome: res.outcome }, { status: 400 });

  return NextResponse.json({
    ok: true,
    outcome: res.outcome,
    id: feature.id,
    name: feature.name,
    branch: res.branch,
    accepted: res.accepted,
    total: res.total,
    text:
      res.outcome === "already-armed"
        ? `"${feature.name}" was already running — nothing to do.`
        : `Approved "${feature.name}": accepted ${res.accepted} of ${res.total} task(s), branch ${res.branch}. Autopilot has the queue.`,
  });
}
