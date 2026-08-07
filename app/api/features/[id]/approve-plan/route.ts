import { NextResponse } from "next/server";
import { getFeature, getProject } from "@/lib/store";
import { approvePlan } from "@/lib/approvePlan";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Gate 1 — the user approves the plan. The work lives in lib/approvePlan.ts so
// feature chaining can apply the same treatment without an HTTP request; this
// wrapper only maps the outcome onto HTTP. flag-off stays a 400 here (the
// button must say why it did nothing) while chain kickoff just logs it.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });

  const res = await approvePlan(feature, project);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, branch: res.branch, accepted: res.accepted, total: res.total });
}
