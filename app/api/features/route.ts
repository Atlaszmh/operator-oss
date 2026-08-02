import { NextResponse } from "next/server";
import { createFeature, findFeature, getProject, listFeatures } from "@/lib/store";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// A project's features with their progress rollup. The tasks column normally
// gets these bundled into GET /api/projects/[id] (one fetch, one refresh path);
// this endpoint exists for callers that want features alone.
export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get("project_id") ?? "";
  if (!projectId || !getProject(projectId))
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  return NextResponse.json({ features: listFeatures(projectId) });
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.project_id || !getProject(body.project_id))
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  // UNIQUE(project_id, name) would throw on a duplicate; a 409 naming the
  // existing feature is more useful to the client than a constraint error.
  if (findFeature(body.project_id, name))
    return NextResponse.json({ error: `a feature named "${name}" already exists in this project` }, { status: 409 });

  const feature = createFeature({
    project_id: body.project_id,
    name,
    description: typeof body.description === "string" ? body.description : "",
    context: typeof body.context === "string" ? body.context : "",
    color: typeof body.color === "string" ? body.color : "",
  });
  track("feature_created", { feature_id: feature.id, project_id: feature.project_id });
  return NextResponse.json(feature, { status: 201 });
}
