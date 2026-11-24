// Gemini CLI's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Kept 100% SDK- and node-pty-free
// so lib/agents/capabilities.ts can import it from any route without pulling
// native modules into the Next.js server bundle (pinned by tests/importGraph.test.ts).

import type { AgentCapabilities } from "../types";

// Every Gemini 2.5 and 3.x model in @google/gemini-cli runs a 1M token context window.
const CTX = 1_000_000;

export const GEMINI_CAPABILITIES: AgentCapabilities = {
  // Mirrors @google/gemini-cli's model definitions (packages/core/src/config/models.ts).
  // Groups must stay contiguous so the picker renders one section header per group.
  //
  // `tier` marks delegation targets for suggest_task (buildDelegationGuidance in
  // lib/agents/shared.ts). 3.8 Flash matches 3.1 Pro on SWE-bench and beats it on
  // Terminal-Bench at ~1/3 the price, so it is the everyday default; heavy is
  // left unset and folds up to max.
  //   - max:      gemini-3.1-pro-preview (frontier reasoning & architecture)
  //   - standard: gemini-3.8-flash       (agentic coding, near-Pro quality)
  //   - light:    gemini-3.5-flash-lite  (cheapest mechanical edits)
  models: [
    {
      value: "auto",
      label: "Auto (Gemini 3)",
      sub: "lets Gemini CLI route between Pro & Flash · 1M context",
      contextWindow: CTX,
      group: "Latest",
    },
    {
      value: "gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro",
      sub: "frontier coding & deep reasoning · 1M context",
      contextWindow: CTX,
      group: "Latest",
      tier: "max",
    },
    {
      value: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      sub: "near-Pro agentic coding at Flash cost · 1M context",
      contextWindow: CTX,
      group: "Latest",
      tier: "standard",
    },
    {
      value: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      sub: "balanced speed & quality · 1M context",
      contextWindow: CTX,
      group: "Latest",
    },
    {
      value: "gemini-3.5-flash-lite",
      label: "Gemini 3.5 Flash-Lite",
      sub: "fastest, lowest cost · 1M context",
      contextWindow: CTX,
      group: "Latest",
      tier: "light",
    },
    {
      value: "gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash-Lite",
      sub: "lightweight & fast · 1M context",
      contextWindow: CTX,
      group: "Latest",
    },
    {
      value: "gemini-3-pro-preview",
      label: "Gemini 3 Pro",
      sub: "previous generation Pro · 1M context",
      contextWindow: CTX,
      group: "Previous versions",
    },
    {
      value: "gemini-3-flash-preview",
      label: "Gemini 3 Flash",
      sub: "previous generation Flash · 1M context",
      contextWindow: CTX,
      group: "Previous versions",
    },
    {
      value: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      sub: "previous generation Pro · 1M context",
      contextWindow: CTX,
      group: "Previous versions",
    },
    {
      value: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      sub: "previous generation Flash · 1M context",
      contextWindow: CTX,
      group: "Previous versions",
    },
    {
      value: "gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash-Lite",
      sub: "previous generation Flash-Lite · 1M context",
      contextWindow: CTX,
      group: "Previous versions",
    },
  ],
  reasoningOptions: [
    { value: "off", label: "Off", sub: "low thinking level" },
    { value: "think", label: "Think", sub: "medium thinking level" },
    { value: "think_hard", label: "Think hard", sub: "high thinking level (CLI default)" },
    { value: "ultrathink", label: "Ultrathink", sub: "high thinking level, max budget on 2.5" },
  ],
  // Maps to Gemini CLI's --approval-mode flag:
  //   - bypassPermissions -> --approval-mode yolo (auto-approve all tool calls)
  //   - acceptEdits       -> --approval-mode auto_edit (auto-approve file edits)
  //   - plan              -> --approval-mode plan (read-only plan mode)
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "auto-approve all tool calls (--approval-mode yolo)" },
    { value: "acceptEdits", label: "Accept edits", sub: "auto-approve file edits (--approval-mode auto_edit)" },
    { value: "plan", label: "Plan mode", sub: "read-only planning mode (--approval-mode plan)" },
  ],
  // Interactive asks arrive via the stdio MCP bridge's ask_user tool (with
  // Gemini CLI's built-in interactive-only ask_user excluded so the model calls
  // the orchestrator MCP ask_user tool).
  supportsAsks: true,
  supportsMcpTools: true,
  // Google subscription + Google One AI Credits auth reports token counts only
  // in stream-json stats, so cost is estimated at published Gemini API prices.
  reportsCostUsd: false,
  costIsEstimated: true,
  supportsResume: true,
  apiKeyHint: "AIza…",
  loginStyle: "paste_code",
};

