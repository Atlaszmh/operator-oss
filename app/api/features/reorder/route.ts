import { NextResponse } from "next/server";
import { reorderFeatures } from "@/lib/store";

export const dynamic = "force-dynamic";

// Persist a manual feature ordering (drag in the tasks column). Mirrors
// /api/projects/reorder and /api/tasks/reorder: `ids` is the desired order and
// each feature's position becomes its index.
export async function POST(req: Request) {
  const body = await req.json();
  if (!Array.isArray(body?.ids)) return NextResponse.json({ error: "ids array required" }, { status: 400 });
  reorderFeatures(body.ids.filter((id: unknown): id is string => typeof id === "string"));
  return NextResponse.json({ ok: true });
}
