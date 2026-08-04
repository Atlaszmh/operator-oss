import { NextResponse, type NextRequest } from "next/server";
import { getProject, getTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `suggest_task` tool call to, so non-Claude agents (Codex, future CLIs) get the
// same tool the Claude driver mounts in-process. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath). The bridge has
// already resolved any title refs in `blocked_by` to task ids.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    title?: string;
    description?: string;
    priority?: Priority;
    blocked_by?: string[];
    model?: string;
    reasoning?: string;
    feature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const { task, text } = createSuggestedTask(project, {
    title: body.title,
    description: body.description ?? "",
    priority: body.priority,
    blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : undefined,
    // Unvalidated on purpose — createSuggestedTask owns that, so both call paths
    // get identical treatment from one place.
    model: typeof body.model === "string" ? body.model : undefined,
    reasoning: typeof body.reasoning === "string" ? body.reasoning : undefined,
    // Resolved (and auto-created) inside createSuggestedTask, so the bridge and
    // the in-process server land on identical behaviour.
    feature: typeof body.feature === "string" ? body.feature : undefined,
    // The bridge sends the calling task's id (scripts/orch-mcp.mjs). Its feature
    // is the default when the agent named none — same rule the Claude driver
    // applies in-process, so both paths file follow-up work the same way.
    inheritFeatureId: body.taskId ? (getTask(body.taskId)?.feature_id ?? null) : null,
  });
  return NextResponse.json({ ok: true, id: task.id, title: task.title, text });
}
