import { NextResponse } from "next/server";
import { getFeature, updateFeature, deleteFeature, findFeature, listFeatures } from "@/lib/store";
import type { Feature } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Return the rollup-carrying row, not the bare one — every consumer wants the
  // counts, and re-deriving them client-side would be a second implementation.
  const withCounts = listFeatures(feature.project_id).find((f) => f.id === id);
  return NextResponse.json(withCounts ?? feature);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cur = getFeature(id);
  if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();

  // Whitelist. `branch`/`base_sha`/`merged_at`/`pr_url` are deliberately absent:
  // those are git state, owned by the /branch, /ship and /pr routes, which hold
  // the guards. A PATCH that could set `branch` directly would let the client
  // re-point live worktrees' merge target without any of them.
  //
  const allowed: Partial<Feature> = {};
  for (const k of ["description", "context", "color", "archived", "position"] as const) {
    if (k in body) (allowed as Record<string, unknown>)[k] = body[k];
  }
  // `autopilot` is accepted here as the PAUSE switch only — any value turns it
  // off. Turning it on is /approve-plan, which also cuts the integration branch
  // and accepts the plan's suggestions; a bare PATCH that could set it to 1
  // would start unattended work merging onto the project branch. Pausing must
  // never be harder than resuming, so it stays a plain field the client sets.
  if ("autopilot" in body) allowed.autopilot = 0;
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const clash = findFeature(cur.project_id, name);
    if (clash && clash.id !== id)
      return NextResponse.json({ error: `a feature named "${name}" already exists in this project` }, { status: 409 });
    allowed.name = name;
  }

  const feature = updateFeature(id, allowed);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listFeatures(feature.project_id).find((f) => f.id === id) ?? feature);
}

// Deletes the grouping ONLY. Member tasks survive with feature_id NULL (the
// ON DELETE SET NULL in lib/db.ts), along with their worktrees and branches —
// removing an organizational mistake must not destroy the work inside it. The
// feature's own integration branch is likewise left in the repo: it may hold
// merged task commits that aren't on the project branch yet.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getFeature(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  deleteFeature(id);
  return NextResponse.json({ ok: true });
}
