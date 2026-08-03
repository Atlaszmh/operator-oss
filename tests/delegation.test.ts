import { describe, it, expect } from "vitest";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";
import { buildDelegationGuidance } from "@/lib/agents/shared";
import { createProject, createTask, getTask } from "@/lib/store";
import type { AgentCapabilities } from "@/lib/agents/types";

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

describe("buildDelegationGuidance", () => {
  it("lists Claude's four tiers cheapest-first with a work description each", () => {
    const g = buildDelegationGuidance(CLAUDE_CAPABILITIES);
    expect(g).toContain("`haiku`");
    expect(g).toContain("`fable`");
    // Untiered options never appear.
    expect(g).not.toContain("opus[1m]");
    expect(g).not.toContain("claude-opus-4-6");
    // Cheapest first, so a skimming planner meets the cheap option before the
    // expensive one.
    expect(g.indexOf("`haiku`")).toBeLessThan(g.indexOf("`fable`"));
  });

  it("gives a three-tier agent a destination for all four categories of work", () => {
    const g = buildDelegationGuidance(CODEX_CAPABILITIES);
    expect(g).toContain("gpt-5.4-mini");
    expect(g).toContain("gpt-5.4");
    expect(g).toContain("gpt-5.5");
    // No `standard` entry, so ordinary work folds UP onto heavy (5.4) rather
    // than collecting on the frontier model.
    const heavyLine = g.split("\n").find((l) => l.includes("`gpt-5.4`"))!;
    expect(heavyLine).toContain("ordinary feature work");
    expect(heavyLine).toContain("multi-file refactors");
    const maxLine = g.split("\n").find((l) => l.includes("`gpt-5.5`"))!;
    expect(maxLine).toContain("whole-codebase reasoning");
    expect(maxLine).not.toContain("ordinary feature work");
    // Pinned previous versions are picker-only, same rule as Claude's.
    expect(g).not.toContain("gpt-5.3-codex");
    expect(g).not.toContain("gpt-5.2");
  });

  it("names the lowest and highest reasoning presets", () => {
    const g = buildDelegationGuidance(CLAUDE_CAPABILITIES);
    expect(g).toContain("`off`");
    expect(g).toContain("`ultrathink`");
  });

  it("returns empty for an agent with no tiered models, so the tool reads as it did before", () => {
    const caps = {
      ...CLAUDE_CAPABILITIES,
      models: CLAUDE_CAPABILITIES.models.map(({ tier: _tier, ...m }) => m),
    } as AgentCapabilities;
    expect(buildDelegationGuidance(caps)).toBe("");
  });
});

describe("createTask run config", () => {
  it("persists model and reasoning when given", () => {
    const p = createProject({ name: "Store" });
    const t = createTask({ project_id: p.id, title: "T", model: "haiku", reasoning: "off" });
    expect(getTask(t.id)).toMatchObject({ model: "haiku", reasoning: "off" });
  });

  it("defaults both to null — inherit the agent default", () => {
    const p = createProject({ name: "Store2" });
    const t = createTask({ project_id: p.id, title: "T" });
    expect(getTask(t.id)).toMatchObject({ model: null, reasoning: null });
  });
});
