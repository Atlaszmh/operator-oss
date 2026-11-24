import { describe, it, expect } from "vitest";
import {
  flushGeminiState,
  mapGeminiEvent,
  newGeminiState,
  type GeminiStreamEvent,
} from "@/lib/agents/gemini/events";
import {
  DEFAULT_GEMINI_MODEL,
  estimateGeminiCostUsd,
  resolveGeminiModel,
} from "@/lib/agents/gemini/pricing";
import fs from "node:fs";
import { approvalModeFor, geminiThinkingSettingsPath } from "@/lib/agents/gemini/driver";
import type { StreamEvent } from "@/lib/types";

function runEvents(events: GeminiStreamEvent[], initialModel?: string): StreamEvent[] {
  const state = newGeminiState(initialModel);
  const out: StreamEvent[] = [];
  for (const ev of events) {
    out.push(...mapGeminiEvent(ev, state));
  }
  out.push(...flushGeminiState(state));
  return out;
}

const byType = (evs: StreamEvent[], t: StreamEvent["type"]) => evs.filter((e) => e.type === t);

describe("gemini event mapping", () => {
  it("maps init, streaming assistant deltas, tool_use, tool_result, and result stats", () => {
    const evs = runEvents([
      {
        type: "init",
        session_id: "gem-sess-123",
        model: "gemini-3.1-pro-preview",
      },
      {
        type: "message",
        role: "user",
        content: "Add a greeting to hello.ts",
      },
      {
        type: "message",
        role: "assistant",
        content: "I'll read ",
        delta: true,
      },
      {
        type: "message",
        role: "assistant",
        content: "`hello.ts` first.",
        delta: true,
      },
      {
        type: "tool_use",
        tool_name: "read_file",
        tool_id: "call_1",
        parameters: { file_path: "src/hello.ts" },
      },
      {
        type: "tool_result",
        tool_id: "call_1",
        status: "success",
        output: "export const hi = 'world';\n",
      },
      {
        type: "tool_use",
        tool_name: "replace",
        tool_id: "call_2",
        parameters: {
          file_path: "src/hello.ts",
          old_string: "export const hi = 'world';",
          new_string: "export const hi = 'gemini';",
        },
      },
      {
        type: "tool_result",
        tool_id: "call_2",
        status: "success",
        output: "Successfully modified file",
      },
      {
        type: "message",
        role: "assistant",
        content: "Updated `src/hello.ts`.",
        delta: true,
      },
      {
        type: "result",
        status: "success",
        stats: {
          input_tokens: 100_000,
          output_tokens: 10_000,
          cached: 50_000,
          total_tokens: 110_000,
        },
      },
    ]);

    // Session & model from init
    expect(byType(evs, "session")).toEqual([{ type: "session", sessionId: "gem-sess-123" }]);
    expect(byType(evs, "model")).toEqual([{ type: "model", model: "gemini-3.1-pro-preview" }]);

    // Streaming delta chunks coalesce into single assistant messages per boundary
    const assistants = byType(evs, "assistant") as Extract<StreamEvent, { type: "assistant" }>[];
    expect(assistants.map((a) => a.content)).toEqual([
      "I'll read `hello.ts` first.",
      "Updated `src/hello.ts`.",
    ]);

    // Tools normalized to Read + Edit with rich diff peeks
    const tools = byType(evs, "tool") as Extract<StreamEvent, { type: "tool" }>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      id: "call_1",
      title: "📖 Read hello.ts",
      file: "src/hello.ts",
    });
    expect(tools[1]).toMatchObject({
      id: "call_2",
      title: "✎ Edit hello.ts",
      file: "src/hello.ts",
    });
    expect(tools[1].peek?.kind).toBe("diff");

    // Usage event calculated from stats
    const usage = byType(evs, "usage") as Extract<StreamEvent, { type: "usage" }>[];
    expect(usage).toHaveLength(1);
    expect(usage[0].usage).toMatchObject({
      input_tokens: 100_000,
      output_tokens: 10_000,
      cache_read_tokens: 50_000,
      cache_creation_tokens: 0,
    });
    // 50k fresh × $2/1M ($0.10) + 50k cached × $0.20/1M ($0.01) + 10k output × $12/1M ($0.12) = $0.23
    expect(usage[0].usage.cost_usd).toBeCloseTo(0.23, 6);
  });

  it("suppresses ask_user tool rows while mapping MCP tools, warnings, and errors", () => {
    const evs = runEvents([
      {
        type: "tool_use",
        tool_name: "mcp_orchestrator_ask_user",
        tool_id: "ask_1",
        parameters: { questions: [] },
      },
      {
        type: "tool_result",
        tool_id: "ask_1",
        status: "success",
        output: "answered",
      },
      {
        type: "tool_use",
        tool_name: "mcp_docs_search",
        tool_id: "mcp_1",
        parameters: { q: "gemini credits" },
      },
      {
        type: "tool_result",
        tool_id: "mcp_1",
        status: "success",
        output: "Google One AI Credits",
      },
      {
        type: "error",
        severity: "warning",
        message: "Using Google One AI Credits for this request",
      },
      {
        type: "result",
        status: "error",
        error: { message: "RESOURCE_EXHAUSTED: quota exceeded" },
      },
    ]);

    const tools = byType(evs, "tool") as Extract<StreamEvent, { type: "tool" }>[];
    expect(tools).toHaveLength(1);
    expect(tools[0].title).toBe("⚙ docs: search");

    const notices = byType(evs, "notice") as Extract<StreamEvent, { type: "notice" }>[];
    expect(notices.map((n) => n.content)).toEqual(["Using Google One AI Credits for this request"]);

    const errors = byType(evs, "error") as Extract<StreamEvent, { type: "error" }>[];
    expect(errors.map((e) => e.content)).toEqual(["RESOURCE_EXHAUSTED: quota exceeded"]);
  });
});

describe("gemini pricing & controls", () => {
  it("resolves default model when null or auto", () => {
    expect(resolveGeminiModel(null)).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel("auto")).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel("gemini-3-flash-preview")).toBe("gemini-3-flash-preview");
  });

  it("prices Flash and Flash-Lite accurately and clamps cached tokens", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 400_000 };
    // Gemini 3 Flash: 600k×$0.50 + 400k×$0.05 + 100k×$3.00 = 0.30 + 0.02 + 0.30 = $0.62
    expect(estimateGeminiCostUsd("gemini-3-flash-preview", usage)).toBeCloseTo(0.62, 8);
    // Gemini 3.5 Flash-Lite: 600k×$0.30 + 400k×$0.03 + 100k×$2.50 = 0.18 + 0.012 + 0.25 = $0.442
    expect(estimateGeminiCostUsd("gemini-3.5-flash-lite", usage)).toBeCloseTo(0.442, 8);
  });

  it("maps permission modes to Gemini CLI approval modes", () => {
    expect(approvalModeFor(null)).toBe("yolo");
    expect(approvalModeFor("bypassPermissions")).toBe("yolo");
    expect(approvalModeFor("acceptEdits")).toBe("auto_edit");
    expect(approvalModeFor("plan")).toBe("plan");
  });

  it("writes a thinking override settings file per reasoning preset", () => {
    expect(geminiThinkingSettingsPath(null)).toBeNull();
    const cfg = JSON.parse(fs.readFileSync(geminiThinkingSettingsPath("off")!, "utf8"));
    expect(cfg.modelConfigs.customOverrides).toEqual([
      { match: { model: "chat-base-3" }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: "LOW" } } } },
      { match: { model: "chat-base-2.5" }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingBudget: 1024 } } } },
    ]);
  });
});

