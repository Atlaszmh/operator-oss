import { describe, it, expect } from "vitest";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";

// buildDelegationGuidance assumes at most one model per tier — a second one
// would be silently dropped from the menu, so the descriptors are pinned here
// rather than the generator defensively picking a winner.
describe("model tiers", () => {
  for (const [name, caps] of [["claude", CLAUDE_CAPABILITIES], ["codex", CODEX_CAPABILITIES]] as const) {
    it(`${name} declares each tier at most once`, () => {
      const tiers = caps.models.map((m) => m.tier).filter(Boolean);
      expect(tiers.length).toBe(new Set(tiers).size);
    });

    it(`${name} declares at least one tiered model`, () => {
      expect(caps.models.some((m) => m.tier)).toBe(true);
    });
  }

  it("leaves Claude's pinned and 1M variants untiered — the planner is offered only current families", () => {
    const tiered = CLAUDE_CAPABILITIES.models.filter((m) => m.tier).map((m) => m.value);
    expect(tiered).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });
});
