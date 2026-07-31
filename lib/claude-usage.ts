import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { CLAUDE_CLI_PATH as CLAUDE } from "./config";

const run = promisify(execFile);

// The account usage panel behind Claude's `/usage`, read through the same CLI
// the rest of the app drives (see lib/claude-auth.ts). The Agent SDK's
// rate_limit_event only reports whichever window is currently binding, and
// omits the percentage until usage climbs toward the cap — this is the only
// source that gives every window a live number. `/usage` is a local command:
// no turn, no tokens (total_cost_usd 0, num_turns 0).
//
// Its plain-text body looks like:
//   Current session: 16% used · resets Jul 31, 11:30pm (UTC)
//   Current week (all models): 13% used · resets Aug 6, 6pm (UTC)
//   Current week (Fable): 18% used · resets Aug 6, 6pm (UTC)
// Labels are taken verbatim, so a new model tier shows up as a new row on its
// own rather than needing a mapping table here.

export interface UsageWindow {
  label: string;
  pct: number;
  /** Absolute reset, unix ms — null when the CLI's wording didn't parse. */
  resetsAt: number | null;
  /** The CLI's own reset text, shown as-is when resetsAt is null. */
  resetsText: string;
}

const LINE = /^(.+?):\s*(\d+)%\s*used\s*·\s*resets\s+(.+?)$/;

export function parseUsage(text: string): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(LINE);
    if (m) out.push({ label: m[1].trim(), pct: Number(m[2]), resetsAt: parseReset(m[3]), resetsText: m[3] });
  }
  return out;
}

// "Jul 31, 11:30pm (UTC)" / "Aug 6, 6pm (UTC)" — the minutes are dropped on the
// hour, and there's no year, so assume the nearest one: a date that lands well
// in the past is next year's (the December → January rollover).
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseReset(s: string): number | null {
  const m = s.match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)$/i);
  if (!m) return null;
  const mon = MON.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0);
  const on = (year: number) => Date.UTC(year, mon, Number(m[2]), hour, Number(m[4] ?? 0));
  const now = Date.now();
  const at = on(new Date().getUTCFullYear());
  return at < now - 30 * 86_400_000 ? on(new Date().getUTCFullYear() + 1) : at;
}

// Cached on globalThis (same reason as lib/claude-auth.ts: route chunks each
// import their own copy of the module). Every read is a real `claude` run that
// leaves a session behind in ~/.claude, so don't do it per page open.
const TTL = 5 * 60_000;
const g = globalThis as unknown as { __orchClaudeUsage?: { at: number; rows: UsageWindow[] } };

export async function readClaudeUsage(): Promise<UsageWindow[]> {
  const hit = g.__orchClaudeUsage;
  if (hit && Date.now() - hit.at < TTL) return hit.rows;
  try {
    const { stdout } = await run(CLAUDE, ["-p", "/usage", "--output-format", "json"], {
      timeout: 30_000,
      cwd: os.homedir(),
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    const rows = parseUsage((JSON.parse(stdout) as { result?: string }).result ?? "");
    g.__orchClaudeUsage = { at: Date.now(), rows };
    return rows;
  } catch {
    // Not logged in through the CLI, a timeout, or wording we don't recognize:
    // serve the last good read if we have one, else let the caller fall back to
    // the SDK's rate-limit snapshots.
    return hit?.rows ?? [];
  }
}
