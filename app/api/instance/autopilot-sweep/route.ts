import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// The autopilot heartbeat. server.js pings this over loopback on a timer (with
// the service token, mirroring the health probes and the boot service restore).
//
// Until this existed, sweepAutopilot() had exactly one caller: POST
// /api/recaps/sweep, which the BROWSER polls every five minutes
// (app/orchestrator/useRecaps.ts). So the safety net that resumes a queue after
// a restart — and the only thing that notices work which arrived without a
// turn_end event — ran only while somebody had a tab open. Close the laptop and
// an "unattended" queue stopped being either.
//
// Deliberately NOT the recaps route: that one also generates project recaps,
// which are LLM calls, and a server-side timer must not quietly spend tokens on
// summaries nobody asked for. This does one thing.
//
// Idempotent and cheap: sweep() is serialized per project and a project with no
// armed feature is one indexed query and a return. Dynamic import for the same
// Turbopack reason as services-restore — lib/autopilot's graph reaches the ESM
// agent-SDK externals, so a static namespace import can be unresolved at
// request time in the production build.
export async function POST() {
  const { sweepAutopilot } = await import("@/lib/autopilot");
  const { sweepMergedWorktrees } = await import("@/lib/maintenance");
  await sweepAutopilot();
  // Rate-limited internally to hourly — this is the timer, not the schedule.
  const pruned = await sweepMergedWorktrees().catch(() => 0);
  return NextResponse.json({ ok: true, pruned });
}
