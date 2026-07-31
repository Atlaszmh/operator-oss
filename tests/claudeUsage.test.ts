import { describe, expect, it } from "vitest";
import { parseUsage } from "../lib/claude-usage";

// The shape of `claude -p "/usage" --output-format json` → .result. Wording and
// layout are the CLI's; the figures are synthetic. Both reset forms appear on
// purpose: with minutes ("11:30pm") and on the hour ("6pm").
const PANEL = `You are currently using your subscription to power your Claude Code usage

Current session: 42% used · resets Jul 31, 11:30pm (UTC)
Current week (all models): 7% used · resets Aug 6, 6pm (UTC)
Current week (Fable): 58% used · resets Aug 6, 6pm (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 200 requests · 20 sessions
  Top MCP servers: orchestrator 25%`;

describe("parseUsage", () => {
  it("pulls one row per window and ignores the prose around them", () => {
    const rows = parseUsage(PANEL);
    expect(rows.map((r) => r.label)).toEqual([
      "Current session",
      "Current week (all models)",
      "Current week (Fable)",
    ]);
    expect(rows.map((r) => r.pct)).toEqual([42, 7, 58]);
    // "Top MCP servers: orchestrator 25%" has a percent but no "used · resets".
    expect(rows).toHaveLength(3);
  });

  it("resolves the reset stamp, with and without minutes", () => {
    const [session, week] = parseUsage(PANEL);
    expect(new Date(session.resetsAt!).toISOString()).toMatch(/-07-31T23:30:00/);
    expect(new Date(week.resetsAt!).toISOString()).toMatch(/-08-06T18:00:00/);
    // 12am/12pm must not become 12:00/24:00
    expect(new Date(parseUsage("X: 1% used · resets Jan 2, 12am (UTC)")[0].resetsAt!).getUTCHours()).toBe(0);
    expect(new Date(parseUsage("X: 1% used · resets Jan 2, 12pm (UTC)")[0].resetsAt!).getUTCHours()).toBe(12);
  });

  it("keeps the raw text when the wording doesn't parse", () => {
    const [row] = parseUsage("Current session: 5% used · resets sometime soon");
    expect(row.pct).toBe(5);
    expect(row.resetsAt).toBeNull();
    expect(row.resetsText).toBe("sometime soon");
  });

  it("returns nothing for output with no usage lines", () => {
    expect(parseUsage("You are using an API key, so usage limits don't apply.")).toEqual([]);
    expect(parseUsage("")).toEqual([]);
  });
});
