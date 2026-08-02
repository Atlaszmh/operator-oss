// Shared implementations of the orchestrator's agent-facing tools
// (suggest_task / expose_service). One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. Both are deliberately split so the
// plain-Node bridge (scripts/orch-mcp.mjs) can import the defs without pulling in
// the TS/SQLite graph.

import { nanoid } from "nanoid";
import type { Project, Task, ServiceInfo, Priority, AskQuestion, ToolData } from "./types";
import { createTask, setTaskDeps, addMessage, updateMessage, updateTask } from "./store";
import { getCapabilities } from "./agents/capabilities";
import { exposeService } from "./services";
import { publish } from "./events";
import { waitForAnswer, settleAsk } from "./asks";
import { turnSignal } from "./abort";
import { formatAnswers } from "./agents/shared";

/**
 * Resolve `blocked_by` refs against a per-session title→id map: an id passes
 * through; a title of a task suggested earlier this session maps to its id;
 * anything else is left as-is (setTaskDeps drops unknown/foreign ids safely).
 * Callers own the map because it is inherently session-scoped — the Claude
 * driver keeps one per turn, the stdio bridge keeps one per (per-turn) process.
 */
export function resolveTitleRefs(refs: string[] | undefined, createdByTitle: Map<string, string>): string[] {
  return (refs ?? []).map((ref) => createdByTitle.get(ref) ?? ref);
}

export interface SuggestTaskInput {
  title: string;
  description: string;
  priority?: Priority;
  /** Already resolved to task ids (see resolveTitleRefs) — id passes through to setTaskDeps. */
  blocked_by?: string[];
  /** Raw model / reasoning values from the agent — validated below, never trusted. */
  model?: string;
  reasoning?: string;
}

/**
 * Check the run config an agent chose against the descriptor of the agent that
 * will actually run the task. This is a trust boundary: both values are free
 * text produced by a language model and land in a database write.
 *
 * An unrecognised value degrades to null (inherit) rather than throwing, and
 * comes back as a note appended to the text the agent receives — which is the
 * point. A planner that gets told its guess was wrong fixes the next of its
 * twenty calls; one that gets a silent null repeats the mistake all twenty times.
 *
 * Anything in the descriptor is accepted, including untiered options: `tier`
 * governs what the guidance OFFERS, not what the tool ALLOWS. Rejecting a pinned
 * model an agent named correctly would make the accepted set differ from the
 * human picker's for no benefit.
 */
function validateRun(agent: string | null | undefined, input: SuggestTaskInput): { model: string | null; reasoning: string | null; note: string } {
  const caps = getCapabilities(agent);
  const notes: string[] = [];
  const pick = (kind: string, raw: string | undefined, allowed: string[]): string | null => {
    if (!raw) return null;
    if (allowed.includes(raw)) return raw;
    notes.push(`${kind} "${raw}" isn't available for this project's agent — using the default.`);
    return null;
  };
  return {
    model: pick("model", input.model, caps.models.map((m) => m.value)),
    reasoning: pick("reasoning", input.reasoning, caps.reasoningOptions.map((r) => r.value)),
    note: notes.length ? ` (${notes.join(" ")})` : "",
  };
}

/**
 * Create a suggested task in `project` and (optionally) set its dependencies.
 * Returns the created task plus the human-readable confirmation text both the
 * MCP server and the HTTP endpoint hand back to the agent verbatim. Bad deps
 * degrade to a note rather than throwing (setTaskDeps drops foreign ids and
 * rejects cycles).
 */
export function createSuggestedTask(project: Project, input: SuggestTaskInput): { task: Task; text: string } {
  // The task's agent is projects.default_agent (suggest_task never sets one, so
  // createTask falls back to it) — validate against that agent's descriptor.
  const run = validateRun(project.default_agent, input);
  const task = createTask({
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
    model: run.model,
    reasoning: run.reasoning,
  });
  let depNote = "";
  if (input.blocked_by?.length) {
    try {
      setTaskDeps(task.id, input.blocked_by);
      depNote = ` Blocked by ${input.blocked_by.length} task(s).`;
    } catch (e) {
      depNote = ` (Could not set dependencies: ${(e as Error).message}.)`;
    }
  }
  return {
    task,
    text: `Suggested task "${input.title}" added to the project tray (id: ${task.id}).${depNote}${run.note}`,
  };
}

/**
 * Register a service the agent just started (the expose_service tool). Records
 * the port/url so it shows in the Services panel and returns the URL to hand the
 * user, plus the confirmation text. We don't own the process — this entry is
 * informational (see lib/services.ts exposeService).
 */
/**
 * Surface an ask_user question card and wait for the answer — the bridge-served
 * counterpart of the Claude driver's AskUserQuestion hook. Unlike suggest_task /
 * expose_service this is asynchronous by nature: we persist + publish the ask
 * card here (the same tool-row shape the runner writes, so the UI and the
 * /answer route treat it identically), then park a DETACHED waiter on
 * lib/asks.ts. The bridge polls takeAskOutcome() via the wait endpoint — no
 * long-held HTTP request, per the house rule. The waiter is tied to the live
 * turn's abort signal, so a Stop settles it as a dismissal.
 */
export function startAskUser(task: Task, questions: AskQuestion[]): { askId: string } {
  const askId = `ask-${nanoid()}`;
  const data: ToolData = { title: "Question for you", ask: { id: askId, questions } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  // The turn is live but parked on the user — same flag the runner sets for
  // Claude asks, driving the "Needs your input" badges. Cleared on answer below;
  // the runner's turn-end finally re-settles it either way.
  updateTask(task.id, { awaiting_input: 1 });
  publish(task.id, { type: "ask", id: askId, questions, msgId: m.id, generation: task.generation });

  void waitForAnswer(task.id, askId, questions, turnSignal(task.id))
    .then((answers) => {
      data.ask = { id: askId, questions, answers };
      updateMessage(m.id, JSON.stringify(data));
      updateTask(task.id, { awaiting_input: 0 });
      publish(task.id, { type: "ask_answered", id: askId, answers, msgId: m.id, generation: task.generation });
      settleAsk(task.id, askId, formatAnswers(questions, answers));
    })
    .catch(() => {
      // Turn torn down (Stop) before an answer arrived. The card stays in the
      // transcript unanswered — answering it later falls back to the /answer
      // route's resolved:false path (a normal reply into a fresh turn).
      settleAsk(task.id, askId, "The user dismissed the question without answering.");
    });

  return { askId };
}

export function registerExposedService(project: Project, name: string, port: number): { info: ServiceInfo; url: string; text: string } {
  const info = exposeService(project, name.trim() || "dev", port);
  const url = info.url ?? `http://localhost:${port}`;
  const text =
    `Registered "${info.name}" on port ${port}. It's reachable at ${url} — ` +
    `give the user this exact URL. It now shows in the project's Services panel` +
    (info.visibility === "private"
      ? ` (visibility: private — only the signed-in owner can open it; they can share it from the panel).`
      : ` (visibility: ${info.visibility}).`);
  return { info, url, text };
}
