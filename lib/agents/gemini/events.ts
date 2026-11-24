// The Gemini CLI event normalizer — pure functions that turn `gemini -p ...
// --output-format stream-json` JSONL events into Operator's agent-agnostic
// StreamEvent contract (lib/types.ts). Kept separate from driver.ts so it can
// be unit-tested against recorded JSONL fixtures without spawning the CLI.

import type { StreamEvent } from "../../types";
import { clip, describeToolUse, summarizeResult, type ResultKind } from "../shared";
import { DEFAULT_GEMINI_MODEL, estimateGeminiCostUsd } from "./pricing";

export type GeminiStreamEvent =
  | {
      type: "init";
      timestamp?: string;
      session_id: string;
      model?: string;
    }
  | {
      type: "message";
      timestamp?: string;
      role: "user" | "assistant";
      content: string;
      delta?: boolean;
    }
  | {
      type: "tool_use";
      timestamp?: string;
      tool_name: string;
      tool_id: string;
      parameters?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      timestamp?: string;
      tool_id: string;
      status: "success" | "error";
      output?: string;
      error?: { type?: string; message: string };
    }
  | {
      type: "error";
      timestamp?: string;
      severity?: "warning" | "error";
      message: string;
    }
  | {
      type: "result";
      timestamp?: string;
      status: "success" | "error";
      error?: { type?: string; message: string };
      stats?: {
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        cached?: number;
        input?: number;
        duration_ms?: number;
        tool_calls?: number;
      };
    };

export interface GeminiMapState {
  sessionId: string | null;
  model: string;
  assistantBuffer: string;
  emittedTool: Set<string>;
  suppressedTools: Set<string>;
  toolResultKind: Map<string, ResultKind>;
}

export function newGeminiState(model: string = DEFAULT_GEMINI_MODEL): GeminiMapState {
  return {
    sessionId: null,
    model: model || DEFAULT_GEMINI_MODEL,
    assistantBuffer: "",
    emittedTool: new Set<string>(),
    suppressedTools: new Set<string>(),
    toolResultKind: new Map<string, ResultKind>(),
  };
}

/** Flush any buffered `delta: true` assistant chunks into a single `assistant` event. */
export function flushGeminiState(state: GeminiMapState): StreamEvent[] {
  const text = state.assistantBuffer;
  state.assistantBuffer = "";
  if (!text.trim()) return [];
  return [{ type: "assistant", content: text }];
}

/**
 * Map one Gemini CLI `stream-json` event into zero or more Operator StreamEvents.
 * Mutates `state` in place across the turn.
 */
export function mapGeminiEvent(ev: GeminiStreamEvent, state: GeminiMapState): StreamEvent[] {
  switch (ev.type) {
    case "init": {
      const out: StreamEvent[] = [];
      if (ev.session_id) {
        state.sessionId = ev.session_id;
        out.push({ type: "session", sessionId: ev.session_id });
      }
      if (ev.model && ev.model !== "auto") {
        state.model = ev.model;
      }
      out.push({ type: "model", model: state.model });
      return out;
    }

    case "message": {
      // The runner already echoes the user's message on turn start.
      if (ev.role === "user") return [];
      if (ev.role === "assistant") {
        if (ev.delta) {
          state.assistantBuffer += ev.content ?? "";
          return [];
        }
        const combined = state.assistantBuffer + (ev.content ?? "");
        state.assistantBuffer = "";
        return combined.trim() ? [{ type: "assistant", content: combined }] : [];
      }
      return [];
    }

    case "tool_use": {
      const out = flushGeminiState(state);
      const id = ev.tool_id || `tool_${state.emittedTool.size + 1}`;
      const name = ev.tool_name || "tool";
      const params = ev.parameters ?? {};

      // Suppress ask_user tool rows: the orchestrator MCP bridge's ask_user
      // endpoint publishes the interactive ask card + ask_answered directly.
      if (name === "ask_user" || name === "mcp_orchestrator_ask_user") {
        state.suppressedTools.add(id);
        return out;
      }

      if (state.emittedTool.has(id)) return out;
      state.emittedTool.add(id);

      const desc = describeGeminiToolUse(name, params);
      if (desc.resultKind) state.toolResultKind.set(id, desc.resultKind);

      out.push({
        type: "tool",
        id,
        title: desc.title,
        detail: desc.detail,
        file: desc.file,
        peek: desc.peek,
        diff: desc.diff,
      });
      return out;
    }

    case "tool_result": {
      const id = ev.tool_id;
      if (!id || state.suppressedTools.has(id)) return [];
      const isError = ev.status === "error" || Boolean(ev.error);
      const raw = isError
        ? ev.error?.message || ev.output || "Tool execution failed"
        : (ev.output ?? "");
      const kind = state.toolResultKind.get(id);
      return [
        {
          type: "tool_result",
          id,
          content: clip(raw, 6000),
          isError,
          peek: !isError && kind ? summarizeResult(kind, raw) : undefined,
        },
      ];
    }

    case "error": {
      const out = flushGeminiState(state);
      if (!ev.message) return out;
      if (ev.severity === "warning") {
        out.push({ type: "notice", content: ev.message });
      } else {
        out.push({ type: "error", content: ev.message });
      }
      return out;
    }

    case "result": {
      const out = flushGeminiState(state);
      if (ev.stats) {
        const usage = {
          cost_usd: 0,
          input_tokens: ev.stats.input_tokens ?? 0,
          output_tokens: ev.stats.output_tokens ?? 0,
          cache_read_tokens: ev.stats.cached ?? 0,
          cache_creation_tokens: 0,
        };
        usage.cost_usd = estimateGeminiCostUsd(state.model, usage);
        out.push({ type: "usage", usage });
      }
      if (ev.status === "error" && ev.error?.message) {
        out.push({ type: "error", content: ev.error.message });
      }
      return out;
    }

    default:
      return [];
  }
}

/**
 * Normalize Gemini CLI's built-in tool names (`read_file`, `write_file`, `replace`,
 * `run_shell_command`, `grep_search`, `glob`, `list_directory`, `write_todos`,
 * `google_web_search`, `web_fetch`, and `mcp_<server>_<tool>`) into Operator's
 * shared `describeToolUse` vocabulary so diffs, counts, and previews render identically
 * across Claude, Codex, and Gemini.
 */
function describeGeminiToolUse(name: string, params: Record<string, unknown>) {
  const filePath = (params.file_path ?? params.dir_path ?? params.path) as string | undefined;
  switch (name) {
    case "read_file":
    case "read_many_files":
    case "list_directory":
      return describeToolUse("Read", { ...params, file_path: filePath });

    case "write_file":
      return describeToolUse("Write", {
        ...params,
        file_path: filePath,
        content: typeof params.content === "string" ? params.content : "",
      });

    case "replace":
    case "edit":
      return describeToolUse("Edit", {
        ...params,
        file_path: filePath,
        old_string: typeof params.old_string === "string" ? params.old_string : "",
        new_string: typeof params.new_string === "string" ? params.new_string : "",
      });

    case "run_shell_command":
      return describeToolUse("Bash", {
        ...params,
        command: typeof params.command === "string" ? params.command : "",
      });

    case "grep_search":
    case "search_file_content":
      return describeToolUse("Grep", {
        ...params,
        pattern: params.pattern ?? params.query ?? "",
      });

    case "glob":
      return describeToolUse("Glob", {
        ...params,
        pattern: params.pattern ?? "",
      });

    case "write_todos":
      return describeToolUse("TodoWrite", {
        ...params,
        todos: Array.isArray(params.todos)
          ? (params.todos as Record<string, unknown>[]).map((t) => ({
              content: t.description ?? t.content ?? t.text ?? "",
              status: t.status ?? "pending",
            }))
          : [],
      });

    case "google_web_search":
    case "web_search": {
      const q = String(params.query ?? "");
      return { title: `🔎 Web search: ${q}`, detail: q, resultKind: "output" as ResultKind };
    }

    case "web_fetch": {
      const target = String(params.url ?? params.prompt ?? "");
      return { title: `🌐 Fetch ${target.slice(0, 70)}`, detail: clip(params), resultKind: "output" as ResultKind };
    }

    default: {
      if (name.includes("suggest_task") || name.includes("expose_service")) {
        return describeToolUse(name, params);
      }
      if (name.startsWith("mcp_")) {
        const rest = name.slice(4);
        const sep = rest.indexOf("_");
        if (sep > 0) {
          const server = rest.slice(0, sep);
          const tool = rest.slice(sep + 1);
          return {
            title: `⚙ ${server}: ${tool}`,
            detail: clip(params),
            resultKind: "output" as ResultKind,
          };
        }
      }
      return describeToolUse(name, params);
    }
  }
}

