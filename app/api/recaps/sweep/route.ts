import { NextResponse } from "next/server";
import { sweepRecaps } from "@/lib/recap";
import { sweepAutopilot } from "@/lib/autopilot";
import { sweepFeatureHealth } from "@/lib/featureSync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Generate recaps for any stale projects with new activity. Called by the
// client on load and on an interval; idempotent (only touches projects due).
//
// Autopilot's safety sweep rides the same cadence: its normal driver is the
// turn_end event, which can't fire for a queue that was mid-flight when the
// server restarted. Detached, because a wedged queue must not fail a recap
// request — and idempotent, so overlapping with the event-driven path is fine.
export async function POST() {
  void sweepAutopilot().catch(() => {});
  // Branch-truth reconciliation rides the same cadence, for the same reason:
  // the drifts it heals (a lost ship stamp, post-ship commits on an archived
  // branch) have no event of their own to hook. Detached — git trouble in one
  // repo must not fail a recap request.
  void sweepFeatureHealth().catch(() => {});
  const generated = await sweepRecaps();
  return NextResponse.json({ generated });
}
