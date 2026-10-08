// Claude Code's capability descriptor — what the agent can do, as data
// (rendered into the UI's pickers via GET /api/agents). Split out of driver.ts
// so it can be read without importing the Agent SDK: serverExternalPackages
// make the SDK an async external under Turbopack, and that async-ness poisons
// every transitive importer (see lib/agents/capabilities.ts). A task row's
// null model/reasoning/permission means "inherit the driver default", so the
// lists carry only explicit choices.

import type { AgentCapabilities } from "../types";

// Every value below is a string `claude --model` accepts: a family alias
// ("opus" → the current Opus), a `[1m]` variant (the 1M-context beta of that
// family), or a full model id for a pinned older version. The internal picker
// ids the CLI's own /model menu uses ("opus48", "sonnet46") are NOT accepted by
// --model — it 404s on them — so pins are spelled as full ids. Labels carry the
// version number on purpose: "Opus" alone can't tell you whether a turn ran on
// Opus 5 or 4.8, which is the whole question when a family alias moves.
//
// contextWindow is the window Claude Code actually runs. Every current family
// (Fable 5.1, Opus 5.5, Sonnet 5.5) is 1M natively, so they need no `[1m]`
// variant; only Haiku and the pinned 4.6 ids still run a 200k default.
// The labels name the version the alias resolves to under the CLI pinned in
// the Dockerfile (CLAUDE_CODE_VERSION) — bump both together.
const K200 = 200_000;
const M1 = 1_000_000;

// `tier` marks a model as a suggest_task delegation target (see
// buildDelegationGuidance in lib/agents/shared.ts). Only the four current
// families carry one: offering a planner a pinned legacy version invites it to
// route real work there because the label sounded capable.
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "fable", label: "Fable 5.1", sub: "most capable · 1M context", contextWindow: M1, group: "Latest", tier: "max" },
    { value: "opus", label: "Opus 5.5", sub: "everyday complex work · 1M context", contextWindow: M1, group: "Latest", tier: "heavy" },
    { value: "sonnet", label: "Sonnet 5.5", sub: "efficient for routine tasks · 1M context", contextWindow: M1, group: "Latest", tier: "standard" },
    { value: "haiku", label: "Haiku 4.5", sub: "fastest, lowest cost", contextWindow: K200, group: "Latest", tier: "light" },
    { value: "opusplan", label: "Opus Plan Mode", sub: "Opus while planning, Sonnet after", contextWindow: M1, group: "Latest" },
    { value: "claude-fable-5", label: "Fable 5", sub: "previous Fable", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-opus-5", label: "Opus 5", sub: "previous Opus", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-sonnet-5", label: "Sonnet 5", sub: "previous Sonnet", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-opus-4-8", label: "Opus 4.8", sub: "legacy", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)", sub: "legacy, 1M context", contextWindow: M1, group: "Pinned versions" },
  ],
  reasoningOptions: [
    { value: "off", label: "Off", sub: "no extended thinking" },
    { value: "think", label: "Think", sub: "light reasoning" },
    { value: "think_hard", label: "Think hard", sub: "deeper reasoning" },
    { value: "ultrathink", label: "Ultrathink", sub: "maximum reasoning" },
  ],
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "bypass permissions (default)" },
    { value: "acceptEdits", label: "Accept edits", sub: "auto-accept file edits" },
    { value: "plan", label: "Plan mode", sub: "propose a plan, don't edit" },
  ],
  supportsAsks: true,
  supportsMcpTools: true,
  reportsCostUsd: true,
  costIsEstimated: false,
  supportsResume: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};
