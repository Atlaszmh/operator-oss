/**
 * Timestamped scheduler logging — the autopilot timeline.
 *
 * `docker logs -t` can stamp lines from outside, but the timestamp then lives
 * on the stream rather than in the text: paste an excerpt into an issue and the
 * times are gone, and a line captured through anything but docker never had
 * them. A hang is diagnosed by ordering and gaps, so the timestamp belongs to
 * the line.
 *
 * Format: `2026-08-09T00:36:41.185Z [autopilot] message` — one event per line,
 * always carrying the task/feature id it is about, so a single task's whole
 * lifecycle is `docker logs -t orch-u-<you> | grep <task-id>`.
 */
export function trace(scope: string, msg: string): void {
  console.log(`${new Date().toISOString()} [${scope}] ${msg}`);
}

export function traceWarn(scope: string, msg: string): void {
  console.warn(`${new Date().toISOString()} [${scope}] ${msg}`);
}

/** Seconds, one decimal — every duration in the timeline reads the same way. */
export function secs(sinceMs: number): string {
  return `${((Date.now() - sinceMs) / 1000).toFixed(1)}s`;
}
