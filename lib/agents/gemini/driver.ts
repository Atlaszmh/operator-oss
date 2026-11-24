// The Google Gemini CLI driver — the `gemini` CLI (@google/gemini-cli) behind
// the AgentDriver seam (lib/agents/types.ts), counterpart to
// lib/agents/claude/driver.ts and lib/agents/codex/driver.ts.
//
// Spawns `gemini -p <prompt> --output-format stream-json` and normalizes its
// JSONL event stream into Operator's StreamEvent contract via ./events.ts.
// Supports both Google account subscription login (`oauth-personal` / Code Assist
// with `billing.overageStrategy = "always"` so Google One AI Credits are used
// automatically on eligible Gemini 3 / 3.1 models) and per-token API key billing
// (`GEMINI_API_KEY`).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Project, Task, StreamEvent } from "../../types";
import type { AgentDriver } from "../types";
import { GEMINI_CAPABILITIES } from "./capabilities";
import { getSetting } from "../../store";
import { INTERNAL_BASE_URL, ORCH_MCP_SCRIPT } from "../../config";
import { buildProjectContext } from "../shared";
import {
  flushGeminiState,
  mapGeminiEvent,
  newGeminiState,
  type GeminiStreamEvent,
} from "./events";
import { resolveGeminiModel } from "./pricing";
import {
  buildGeminiEnv,
  ensureGeminiSettings,
  geminiApiKey,
  geminiStatus,
  getGeminiLogin,
  resolveGeminiBinary,
  startGeminiLogin,
  submitGeminiCode,
  verifyGeminiTurn,
  cancelGeminiLogin,
} from "./auth";

/**
 * Map Operator's permission mode to Gemini CLI's `--approval-mode` flag:
 *   - "plan"              -> "plan"      (read-only planning mode)
 *   - "acceptEdits"       -> "auto_edit" (auto-approve file edits)
 *   - "bypassPermissions" -> "yolo"      (auto-approve all tool calls, default)
 */
export function approvalModeFor(mode: string | null | undefined): "yolo" | "auto_edit" | "plan" {
  if (mode === "plan") return "plan";
  if (mode === "acceptEdits") return "auto_edit";
  return "yolo";
}

/**
 * Map Operator's reasoning preset to Gemini CLI thinking config. The CLI pins every
 * 3.x model to thinkingLevel HIGH (alias `chat-base-3`) and 2.5 to a budget
 * (`chat-base-2.5`), so a preset is applied as `modelConfigs.customOverrides` in a
 * system settings file the CLI reads from GEMINI_CLI_SYSTEM_SETTINGS_PATH.
 * LOW is the floor because 3 Pro rejects MINIMAL.
 */
const GEMINI_THINKING: Record<string, { level: string; budget: number }> = {
  off: { level: "LOW", budget: 1024 },
  think: { level: "MEDIUM", budget: 8192 },
  think_hard: { level: "HIGH", budget: 16384 },
  ultrathink: { level: "HIGH", budget: 24576 },
};

/** Path to a settings file overriding thinking for `reasoning`, or null to keep CLI defaults. */
export function geminiThinkingSettingsPath(reasoning: string | null | undefined): string | null {
  const t = reasoning ? GEMINI_THINKING[reasoning] : undefined;
  if (!t) return null;
  const override = (model: string, thinkingConfig: object) => ({
    match: { model },
    modelConfig: { generateContentConfig: { thinkingConfig } },
  });
  const file = path.join(os.tmpdir(), `operator-gemini-thinking-${reasoning}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      modelConfigs: {
        customOverrides: [
          override("chat-base-3", { thinkingLevel: t.level }),
          override("chat-base-2.5", { thinkingBudget: t.budget }),
        ],
      },
    }),
  );
  return file;
}

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
): AsyncGenerator<StreamEvent> {
  ensureGeminiSettings();

  const initialModel = resolveGeminiModel(task.model);
  const state = newGeminiState(initialModel);
  state.sessionId = task.session_id;

  const reasoning =
    task.reasoning ??
    getSetting(`default_reasoning:${task.agent}`) ??
    getSetting("default_reasoning");
  const permission =
    task.permission_mode ??
    getSetting(`default_permission_mode:${task.agent}`) ??
    getSetting("default_permission_mode");
  const approvalMode = approvalModeFor(permission);

  // Seed a fresh session with the project context; resumed turns rely on
  // Gemini CLI's persisted conversation history (`--resume <sessionId>`).
  const prompt = task.session_id
    ? userText
    : `${buildProjectContext(project, task)}\n\n---\n\n${userText}`;

  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--approval-mode",
    approvalMode,
  ];
  if (task.model) {
    args.push("--model", task.model);
  }
  if (task.session_id) {
    args.push("--resume", task.session_id);
  }

  const cwd = task.worktree_path || project.repo_path || process.cwd();
  const env = buildGeminiEnv({
    ORCH_NODE_BIN: process.execPath,
    ORCH_MCP_SCRIPT,
    ORCH_TASK_ID: task.id,
    ORCH_PROJECT_ID: project.id,
    ORCH_BASE_URL: INTERNAL_BASE_URL,
    SERVICE_TOKEN: process.env.SERVICE_TOKEN || "",
  });
  const thinkingSettings = geminiThinkingSettingsPath(reasoning);
  if (thinkingSettings) env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = thinkingSettings;

  yield { type: "model", model: initialModel };

  let emittedError = false;
  let stderrBuf = "";

  try {
    const proc = spawn(resolveGeminiBinary(), args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onAbort = () => {
      try {
        proc.kill();
      } catch {}
    };
    if (abortController?.signal.aborted) {
      onAbort();
    } else {
      abortController?.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 16_000) {
        stderrBuf = stderrBuf.slice(-16_000);
      }
    });

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code));
    });

    if (proc.stdout) {
      const rl = readline.createInterface({
        input: proc.stdout,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (abortController?.signal.aborted) break;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        let parsed: GeminiStreamEvent;
        try {
          parsed = JSON.parse(trimmed) as GeminiStreamEvent;
        } catch {
          continue;
        }
        for (const out of mapGeminiEvent(parsed, state)) {
          if (out.type === "error") emittedError = true;
          yield out;
        }
      }
    }

    for (const out of flushGeminiState(state)) {
      yield out;
    }

    const exitCode = await exitPromise;
    if (
      !abortController?.signal.aborted &&
      exitCode !== 0 &&
      exitCode !== null &&
      !emittedError
    ) {
      const msg = stderrBuf.trim() || `gemini exited with code ${exitCode}`;
      yield { type: "error", content: msg };
    }
  } catch (err) {
    if (!abortController?.signal.aborted && !emittedError) {
      yield {
        type: "error",
        content: err instanceof Error ? err.message : String(err),
      };
    }
  }

  yield { type: "done", sessionId: state.sessionId ?? task.session_id };
}

// ---------- one-shot helpers (no session, text in → text out) ----------

const ONESHOT_MAX_TOOLS_TEXT = 10;
const ONESHOT_MAX_TOOLS_EXPLORE = 80;

async function oneShot(cwd: string, prompt: string, maxTools: number): Promise<string> {
  ensureGeminiSettings();
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--approval-mode",
    "plan",
    "--allowed-mcp-server-names",
    "none",
  ];

  try {
    const proc = spawn(resolveGeminiBinary(), args, {
      cwd,
      env: buildGeminiEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });

    const state = newGeminiState();
    let tools = 0;
    const assistants: string[] = [];

    if (proc.stdout) {
      const rl = readline.createInterface({
        input: proc.stdout,
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        let parsed: GeminiStreamEvent;
        try {
          parsed = JSON.parse(trimmed) as GeminiStreamEvent;
        } catch {
          continue;
        }
        if (parsed.type === "tool_use" && ++tools > maxTools) {
          try {
            proc.kill();
          } catch {}
          break;
        }
        for (const ev of mapGeminiEvent(parsed, state)) {
          if (ev.type === "assistant") assistants.push(ev.content);
        }
      }
    }
    for (const ev of flushGeminiState(state)) {
      if (ev.type === "assistant") assistants.push(ev.content);
    }
    return (assistants[assistants.length - 1] ?? "").trim();
  } catch {
    return "";
  }
}

async function summarizeTranscript(transcript: string, project: Project): Promise<string> {
  const out = await oneShot(
    project.repo_path || process.cwd(),
    `Summarize the following Gemini session into a concise handoff note for a fresh session continuing the ` +
      `same task. Cover: what was done, the current state of the code, decisions made, and what remains. Be ` +
      `specific about files and follow-ups. Output only the note.\n\n=== TRANSCRIPT ===\n${transcript}`,
    ONESHOT_MAX_TOOLS_TEXT,
  );
  return out || "(no summary produced)";
}

const CTX_OPEN = "<<<CONTEXT>>>";
const CTX_CLOSE = "<<<END_CONTEXT>>>";

async function draftProjectContext(project: Project, digest: string): Promise<string> {
  const out = await oneShot(
    project.repo_path || process.cwd(),
    `You are refreshing the saved "project context" for the project "${project.name}". This context is prepended ` +
      `to every new session in this project, so it must get a fresh session up to speed fast and accurately reflect ` +
      `what the project IS NOW.\n\n` +
      `Explore the repository in your working directory (read key files, list the tree, grep for patterns, check ` +
      `package manifests and configs, skim the README and entry points). Then write the new context.\n\n` +
      `Cover, concisely: what the app does and its purpose; the tech stack and key dependencies; how the code is ` +
      `organized (the directories/modules that matter and what lives where); important conventions, patterns, and ` +
      `constraints; how to run/build/test it; and any other orientation a new contributor needs. Prefer concrete ` +
      `file paths over vague description. Be accurate — only state what you verified in the code.\n\n` +
      `Write the context as plain markdown (no code fences around the whole thing), tight and information-dense, ` +
      `~200–500 words. Wrap ONLY the final document between a line containing ${CTX_OPEN} and a line containing ` +
      `${CTX_CLOSE}.\n\n=== EXISTING SAVED CONTEXT (may be stale) ===\n${project.context || "(none)"}\n\n` +
      `=== RECENT ACTIVITY ===\n${digest || "(none)"}`,
    ONESHOT_MAX_TOOLS_EXPLORE,
  );
  const open = out.indexOf(CTX_OPEN);
  const close = out.lastIndexOf(CTX_CLOSE);
  let doc = open !== -1 && close > open ? out.slice(open + CTX_OPEN.length, close) : out;
  doc = doc.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
  return doc || "(no context produced)";
}

async function summarizeProjectRecap(project: Project, digest: string): Promise<string> {
  const out = await oneShot(
    project.repo_path || process.cwd(),
    `Write a very short "where I left off" recap for the project "${project.name}", shown when the user returns after ` +
      `time away. Output ONLY 2–4 terse markdown bullet points ("- " each), one line each, ideally under ~12 words. ` +
      `Be concrete about features, files, and tasks. No headings, no intro/outro, no next steps — recap only what has ` +
      `already happened.\n\n=== PROJECT CONTEXT ===\n${project.context || "(none)"}\n\n=== RECENT ACTIVITY ===\n${digest}`,
    ONESHOT_MAX_TOOLS_TEXT,
  );
  return out || "(no recap produced)";
}

async function reviewTask(prompt: string, cwd: string): Promise<string> {
  return oneShot(cwd || process.cwd(), prompt, ONESHOT_MAX_TOOLS_EXPLORE);
}

export const geminiDriver: AgentDriver = {
  id: "gemini",
  label: "Gemini CLI",
  capabilities: GEMINI_CAPABILITIES,
  runTurn,
  summarizeTranscript,
  draftProjectContext,
  summarizeProjectRecap,
  reviewTask,
  authStatus: geminiStatus,
  startLogin: startGeminiLogin,
  getLogin: getGeminiLogin,
  submitLoginCode: submitGeminiCode,
  cancelLogin: cancelGeminiLogin,
  verify: verifyGeminiTurn,
  apiKey: geminiApiKey,
};

