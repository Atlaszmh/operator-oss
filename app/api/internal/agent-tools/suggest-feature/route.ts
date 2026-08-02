import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { createSuggestedFeature } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `suggest_feature` tool call to, so non-Claude agents (Codex, future CLIs) get
// the same tool the Claude driver mounts in-process. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; name?: string; description?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });

  // Upsert-by-name lives in createSuggestedFeature so both call paths agree —
  // including the rule that a bare re-reference doesn't wipe existing context.
  const { feature, text } = createSuggestedFeature(project, {
    name: body.name,
    description: typeof body.description === "string" ? body.description : undefined,
    context: typeof body.context === "string" ? body.context : undefined,
  });
  return NextResponse.json({ ok: true, id: feature.id, name: feature.name, text });
}
