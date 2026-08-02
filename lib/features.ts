/**
 * Instance-level feature flags.
 *
 * In-progress features default OFF and are turned on per-instance via env, the
 * same env-driven philosophy as lib/config.ts. Flags are resolved server-side
 * (`resolveFeatures`) and handed to the client by injecting `window.__FEATURES`
 * in app/layout.tsx — mirroring how PUBLIC_BASE_URL crosses the boundary — so
 * both sides gate identically without a per-flag NEXT_PUBLIC_ var.
 *
 * To add a flag: extend `Features` + `DEFAULT_FEATURES`, read its env var in
 * `resolveFeatures`, document it in .env.example, and gate the UI on
 * `clientFeatures().<flag>` (client) or `resolveFeatures().<flag>` (server).
 */
export interface Features {
  /** PREVIEW tab (project live-URL view). WIP — depends on the remote-execution
   *  backend landing first, so it stays off until the live URL is real. */
  livePreview: boolean;
  /** Command palette: the toolbar "Jump to project, session, or command…"
   *  omni-search bar and its ⌘K/Ctrl-K shortcut (app/orchestrator/CommandPalette). */
  omniSearch: boolean;
  /** Managed Services — the toolbar "Services" button, the Services config
   *  block in the project-context editor, and the persisted supervisor
   *  (lib/services.ts). Shipped: ON by default; set ORCH_FEATURE_SERVICES=0 to
   *  disable. NOTE: public service hostnames are NOT part of this flag — they
   *  stay opt-in via ORCH_SERVICE_HOSTS (lib/service-host.mjs), so enabling
   *  services exposes nothing publicly. */
  services: boolean;
  /** Autopilot (lib/autopilot.ts): the Approve plan button, the per-feature
   *  switch, and the scheduler that runs an approved plan unattended. Off until
   *  it has earned trust on a real project; ORCH_FEATURE_AUTOPILOT=1. */
  autopilot: boolean;
  /** Autopilot runs its full gate and records the verdict, but never merges on
   *  it — the user still clicks. On by default so that ENABLING autopilot can't
   *  land code on its first run: the reviewer's judgement gets calibrated
   *  against real work before it's trusted. ORCH_FEATURE_AUTOPILOT_SHADOW=0
   *  is the deliberate act of trusting it. */
  autopilotShadow: boolean;
}

export const DEFAULT_FEATURES: Features = {
  livePreview: false,
  omniSearch: false,
  services: true,
  autopilot: false,
  autopilotShadow: true,
};

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "on";
// Unset/empty env keeps the flag's shipped default; any explicit value decides.
// A shipped flag (default ON) is therefore disabled with =0, not by omission.
// lib/service-router.mjs (plain JS, can't import this file) mirrors this read.
const flag = (v: string | undefined, dflt: boolean) => (v ? truthy(v) : dflt);

/** Server-side resolve from env. Never call this from client code (reads env). */
export function resolveFeatures(): Features {
  return {
    livePreview: flag(process.env.ORCH_FEATURE_LIVE_PREVIEW, DEFAULT_FEATURES.livePreview),
    omniSearch: flag(process.env.ORCH_FEATURE_OMNI_SEARCH, DEFAULT_FEATURES.omniSearch),
    services: flag(process.env.ORCH_FEATURE_SERVICES, DEFAULT_FEATURES.services),
    autopilot: flag(process.env.ORCH_FEATURE_AUTOPILOT, DEFAULT_FEATURES.autopilot),
    autopilotShadow: flag(process.env.ORCH_FEATURE_AUTOPILOT_SHADOW, DEFAULT_FEATURES.autopilotShadow),
  };
}

/** Client-side read of the flags injected onto `window` by the root layout. */
export function clientFeatures(): Features {
  // SSR of a client component has no `window` yet. Resolve from env — the same
  // values layout.tsx injects as window.__FEATURES — so the server HTML and the
  // client's first render agree (returning DEFAULT_FEATURES here made every
  // enabled flag a hydration mismatch, e.g. the ⌘K omni button). In the browser
  // this branch never runs, so the process.env reads never execute client-side.
  if (typeof window === "undefined") return resolveFeatures();
  const w = window as unknown as { __FEATURES?: Partial<Features> };
  return { ...DEFAULT_FEATURES, ...(w.__FEATURES ?? {}) };
}
