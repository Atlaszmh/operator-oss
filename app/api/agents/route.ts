import { NextResponse } from "next/server";
import { listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { getSetting } from "@/lib/store";
import { getAgentConnection, getAgentAuthBroken } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// Every registered agent driver's capability descriptor + its persisted
// connection state, so the client can render the model/reasoning/permission
// pickers, gate per-agent features (asks, cost display), and gray out / show a
// "Connect" CTA for agents that aren't wired up yet — all from data, with no
// hardcoded per-agent lists in the UI. Connection state is read from the
// settings record (lib/agents/connections.ts), written on a successful login /
// verify / api-key save, rather than shelling out to every agent's CLI on each
// page load. `authenticated` mirrors `connected` for the run-control pickers.
export async function GET() {
  return NextResponse.json({
    // The app-level default agent (Settings → Run defaults) is the client's
    // ultimate fallback when a project hasn't set its own; unset → the built-in.
    default: getSetting("default_agent") || DEFAULT_AGENT,
    agents: listDrivers().map((d) => {
      const conn = getAgentConnection(d.id);
      return {
        id: d.id,
        label: d.label,
        capabilities: d.capabilities,
        connected: !!conn,
        authenticated: !!conn,
        account: conn ? { email: conn.email, plan: conn.plan, method: conn.method } : null,
        // Connected on record, but its credentials died in flight (expired OAuth
        // session, revoked key) — set by the runner when a turn fails on auth
        // (lib/authFailure.ts) and cleared by the next successful turn or
        // reconnect. Drives the titlebar reconnect banner; a tab that missed the
        // live event picks it up here on load / SSE reconnect.
        authBroken: getAgentAuthBroken(d.id),
      };
    }),
  });
}
