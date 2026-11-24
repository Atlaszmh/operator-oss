// Estimated dollar cost for Gemini CLI turns. Google subscription / Code Assist
// auth (including Google One AI Credits usage) reports token counts in its
// `result.stats` event without a billed USD figure, so we estimate spend as
// token counts × Google's published Gemini API prices for the resolved model.
// This feeds the standard usage/cost pipeline (task_usage.cost_usd) and
// Insights dashboard, with GEMINI_CAPABILITIES.costIsEstimated = true marking
// it with ~ in the UI.

import type { TurnUsage } from "../../types";

// Published Gemini API prices in USD per 1M tokens (ai.google.dev/pricing, Oct 2026).
// 3.8 Flash doubles on 2027-01-01 ($1.50 / $0.15 / $7.50).
// Cached input is 75-90% discounted (~10-25% of input rate). Ordered from
// most-specific prefix to least-specific so `-lite` variants match before
// their parent `-flash` prefix.
const PRICES: { prefix: string; input: number; cachedInput: number; output: number }[] = [
  { prefix: "gemini-3.1-pro", input: 2.0, cachedInput: 0.2, output: 12.0 },
  { prefix: "gemini-3-pro", input: 2.0, cachedInput: 0.2, output: 12.0 },
  { prefix: "gemini-3.8-flash", input: 0.75, cachedInput: 0.075, output: 3.75 },
  { prefix: "gemini-3.5-flash-lite", input: 0.3, cachedInput: 0.03, output: 2.5 },
  { prefix: "gemini-3.5-flash", input: 0.3, cachedInput: 0.03, output: 2.5 },
  { prefix: "gemini-3.1-flash-lite", input: 0.25, cachedInput: 0.025, output: 1.5 },
  { prefix: "gemini-3-flash", input: 0.5, cachedInput: 0.05, output: 3.0 },
  { prefix: "gemini-2.5-pro", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gemini-2.5-flash-lite", input: 0.1, cachedInput: 0.01, output: 0.4 },
  { prefix: "gemini-2.5-flash", input: 0.3, cachedInput: 0.03, output: 2.5 },
  { prefix: "gemini", input: 1.25, cachedInput: 0.125, output: 10.0 },
];

// Default model resolved when a task leaves model unset (tasks.model = null)
// or selects "auto" before the CLI emits its resolved init model.
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";

/** The model a Gemini turn effectively runs: the task's choice, else the CLI default. */
export function resolveGeminiModel(taskModel: string | null | undefined): string {
  if (!taskModel || taskModel === "auto") return DEFAULT_GEMINI_MODEL;
  return taskModel;
}

/**
 * Estimate the dollar cost of a Gemini turn from its token counts.
 * `input_tokens` in Gemini CLI's stream-json `result.stats` is the total prompt
 * token count (including `cached` tokens), so cached reads are clamped to
 * `input_tokens` and priced at `cachedInput`.
 */
export function estimateGeminiCostUsd(
  model: string,
  usage: Pick<TurnUsage, "input_tokens" | "output_tokens" | "cache_read_tokens">,
): number {
  const normalized = (model || DEFAULT_GEMINI_MODEL).toLowerCase();
  const p =
    PRICES.find((r) => normalized.startsWith(r.prefix)) ??
    PRICES.find((r) => DEFAULT_GEMINI_MODEL.startsWith(r.prefix))!;
  const cached = Math.min(Math.max(0, usage.cache_read_tokens), Math.max(0, usage.input_tokens));
  const fresh = Math.max(0, usage.input_tokens - cached);
  const out = Math.max(0, usage.output_tokens);
  return (fresh * p.input + cached * p.cachedInput + out * p.output) / 1_000_000;
}

