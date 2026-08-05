// Detached server-side turn runner.
//
// A Claude turn used to live inside the POST /messages SSE handler, so a page
// reload or dropped connection aborted it. Now POST just calls startTurn() and
// returns: the turn runs here, owned by the server process, persisting every
// event to SQLite and fanning it out over lib/events.ts. Any number of GET
// /messages streams (including zero) can watch; disconnects never touch the
// turn. Stopping is only ever explicit, via lib/abort.ts (/abort route).

import fs from "node:fs";
import { updateTask, addMessage, updateMessage, recordSession, endSession, addUsage, getTask, getProject, addPendingMessage, popPendingMessage, listPendingMessages, clearPendingMessages, getSetting, setSetting, taskBaseBranch } from "@/lib/store";
import { getDriver } from "@/lib/agents/registry";
import { extractOutcome } from "@/lib/agents/shared";
import { claimTurn, handoffTurn, hasTurn, ownsTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { prepareWorktreeMerge, ensureWorktree } from "@/lib/git";
import { catchUpWorktree } from "@/lib/featureSync";
import { track } from "@/lib/analytics";
import { isPromptTooLong, CONTEXT_OVERFLOW_NOTICE, MAX_MESSAGE_CHARS, TOO_LARGE_MESSAGE } from "@/lib/promptLimits";
import { isAuthFailure, AUTH_EXPIRED_NOTICE } from "@/lib/authFailure";
import { isUsageLimit, USAGE_LIMIT_NOTICE } from "@/lib/usageLimit";
import { markAgentAuthBroken, clearAgentAuthBroken } from "@/lib/agents/connections";
import { toolData, type Task, type Project, type ToolData, type TurnUsage } from "@/lib/types";

/**
 * Kick off one user turn in the background. Returns immediately; the caller
 * must have already persisted the user message and set running=1. `syncNote`
 * (the silent worktree fast-forward notice, if any) is persisted + published
 * first so it reads in order at the top of the turn.
 */
export function startTurn(task: Task, project: Project, userText: string, syncNote: string, controller?: AbortController): void {
  // Lets the Stop button abort this turn. Registered by task id so the
  // separate /abort route can find and trip it — and so hasTurn() can report
  // turn liveness to the POST guard and the GET stream's snapshot. Callers
  // that already hold the task's claim (the POST route, the queue drainer's
  // handoff) pass their controller through; anyone else claims here, and the
  // claim is atomic (a synchronous check+register), so two concurrent launches
  // can never both start a turn on the same session.
  const abortController = controller ?? claimTurn(task.id);
  if (!abortController) {
    // Defense-in-depth: the slot is occupied by a live turn. Callers are
    // supposed to claim before launching (so this shouldn't be reachable) —
    // park the message as a queued follow-up rather than double-running the
    // session with a turn the Stop button couldn't reach.
    console.error(`[runner] startTurn(${task.id}) raced a live turn; queueing the message instead`);
    const pm = addPendingMessage(task.id, task.generation, userText);
    publish(task.id, { type: "queued", msgId: pm.id, content: userText, generation: task.generation });
    return;
  }
  // Detached: nobody awaits this. `run()` guards its own body (try/catch/finally)
  // and unregisterTurn runs in that finally, but a throw from the finally itself
  // (e.g. the task row was deleted mid-turn, so updateTask/endSession hit a
  // FOREIGN KEY error) would surface here as an unhandled rejection and, under
  // Node's default policy, crash the entire server — taking down every other
  // tenant's turn. Swallow-and-log so one deleted task can never do that.
  run(task, project, userText, syncNote, abortController).catch((err) => {
    console.error(`[runner] turn for task ${task.id} crashed after its finally settled:`, err);
    // Best-effort settle so even this last-resort path can't wedge the task in
    // a running-forever state. unregisterTurn is identity-checked, so a newer
    // turn's registration is never wiped; if one IS registered (a queued
    // follow-up already took over), leave its state alone.
    try {
      unregisterTurn(task.id, abortController);
      if (!hasTurn(task.id)) {
        const current = getTask(task.id);
        if (current && current.generation === task.generation && current.running) {
          updateTask(task.id, { running: 0 });
        }
        publish(task.id, { type: "turn_end" });
      }
    } catch (settleErr) {
      console.error(`[runner] could not settle task ${task.id} after crash:`, settleErr);
    }
  });
}

/** What a launch attempt produced. The POST route maps this to a Response;
 *  autopilot maps a failure to an escalation the user can see. */
export type LaunchResult = { ok: true; generation: number } | { ok: false; error: string; status: number };

/**
 * Begin a task's VERY FIRST turn: claim the slot, cut its worktree, and send the
 * title + description as the prompt.
 *
 * Lives here beside startResumeTurn rather than inline in the POST route because
 * it has a second caller now — lib/autopilot.ts starts the tasks of an approved
 * plan, and a copy of this over there would be a copy of the worktree self-heal,
 * the claim ordering, and the size guard, drifting from this one on the first
 * edit to either.
 *
 * Takes the per-task lock itself (the lock is NOT re-entrant), so callers must
 * not already hold it.
 */
export async function startInitialTurn(task: Task, project: Project, controller?: AbortController): Promise<LaunchResult> {
  const id = task.id;
  const abortController = controller ?? claimTurn(id);
  if (!abortController) return { ok: false, error: "a turn is already running on this task", status: 409 };

  let launched = false;
  try {
    // The launch runs under the per-task lock shared with the merge/sync/complete
    // routes: those rewrite the worktree with multi-second git operations, and a
    // turn starting mid-commit would hand the agent a worktree being staged (and
    // hand the merge the agent's half-written files). We already hold the turn
    // slot, so a merge waiting on us sees hasTurn() and 409s.
    return await withTaskLock(id, async (): Promise<LaunchResult> => {
      // Re-read under the lock — the task may have moved while we waited (a
      // merge advancing base_sha, a delete). No hasTurn re-check is needed: the
      // claim above owns the slot atomically.
      const fresh = getTask(id);
      if (!fresh) return { ok: false, error: "not found", status: 404 };

      const userText = `${fresh.title}\n\n${fresh.description}`.trim();
      if (!userText) return { ok: false, error: "empty message", status: 400 };
      if (userText.length > MAX_MESSAGE_CHARS) return { ok: false, error: TOO_LARGE_MESSAGE(), status: 413 };

      // Give the task its own git worktree + branch so parallel tasks in the same
      // repo never collide. This runs on the first turn, but also self-heals a task
      // whose worktree is missing on disk — e.g. one reopened after its merged
      // worktree was pruned to reclaim disk. ensureWorktree reattaches to the
      // surviving branch when it still exists, so the old work is restored.
      // Non-git/empty repos fall back to running directly in repo_path
      // (worktree_path stays ""). Best-effort: a git hiccup must not block the run.
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        try {
          // Fork from the task's OWN base — its feature's integration branch when
          // it belongs to one, else the project branch. This is the only place a
          // worktree is cut, so it's the only place that needs to know.
          const wt = await ensureWorktree(project.repo_path, fresh.id, taskBaseBranch(fresh, project));
          if (wt) {
            fresh.worktree_path = wt.path;
            fresh.work_branch = wt.branch;
            fresh.base_sha = wt.baseSha;
            updateTask(id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
          }
        } catch {
          // fall back to repo_path
        }
      }

      const gen = fresh.generation;
      const userMsg = addMessage(id, gen, "user", `**${fresh.title}** — ${fresh.description}`);
      // Mark running immediately, but defer `started` until the agent actually
      // opens a session — so a failed launch leaves the task cleanly retryable.
      updateTask(id, { running: 1, suggested: 0, awaiting_input: 0 });
      // Echo to every open stream of this task (other viewers, and the sender
      // itself — the client renders from events, not optimistically).
      publish(id, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen });
      startTurn(fresh, project, userText, "", abortController);
      launched = true;
      return { ok: true, generation: gen };
    });
  } finally {
    // Every non-launch exit (missing task, empty/oversized prompt, a throw before
    // the runner took over) must free the claim, or the task would read "running"
    // forever and every future message would queue into the void.
    if (!launched) unregisterTurn(id, abortController);
  }
}

/**
 * Begin a *resume* (non-initial) turn for a task: silently catch a conflict-free
 * worktree up to the base branch, persist + echo the user
 * message, flip running on, and hand off to the detached runner. Shared by the
 * POST /messages resume path and the queue drainer (a dequeued follow-up is
 * always a resume turn). Mirrors the prep the POST route does inline for the
 * very first turn; the initial turn stays in the route since it also creates
 * the worktree and sends the title+description as its prompt.
 */
export async function startResumeTurn(task: Task, project: Project, userText: string, controller?: AbortController): Promise<void> {
  const id = task.id;
  const gen = task.generation;
  // Claim the task's turn slot BEFORE the awaits below. The claim is atomic
  // (synchronous check+register), so a concurrent launch can't interleave in
  // the sync-status window and start a second turn on the same session.
  // Callers that already claimed (the POST route, the drain handoff) pass
  // their controller through; if the slot turns out to be occupied, park the
  // message as a queued follow-up — same outcome as the POST route's guard.
  const abortController = controller ?? claimTurn(id);
  if (!abortController) {
    const pm = addPendingMessage(id, gen, userText);
    publish(id, { type: "queued", msgId: pm.id, content: userText, generation: gen });
    return;
  }
  try {
    // Catch the worktree up to base whenever git says the result is conflict-free,
    // so follow-up work isn't built on stale code. Two tiers, both zero-risk:
    // a fast-forward when there's no divergent work, and an ordinary merge when
    // there is but `merge-tree` predicts no conflict.
    //
    // The second tier is the one that matters. Restricting the catch-up to
    // fast-forwards meant a task stopped syncing the moment it committed
    // anything, then drifted one commit further behind for every merge that
    // landed while it waited on the user — so the conflict it eventually hit was
    // the size of the whole wait, not the size of the change. Conflicts were
    // manufactured by queueing, not by the work.
    //
    // A dirty tree is still left alone: prepareWorktreeMerge commits pending
    // edits to get a clean tree, and silently committing an agent's half-finished
    // work at turn start is not this function's call. That case, and any genuine
    // conflict, still go to the user-driven Sync/Fix banner. A git hiccup must
    // never block the turn — just skip the catch-up.
    // The ladder itself lives in lib/featureSync.ts (catchUpWorktree) because
    // three callers need it and they MUST agree: this one at turn start,
    // autopilot's pre-gate catch-up, and the sibling sweep that runs the moment
    // anything lands on a shared base. Autopilot's copy had drifted to a bare
    // fast-forward, which silently did nothing for any task that had committed
    // work — the exact case the second tier exists for.
    //
    // The task's own base — its feature's integration branch when it has one.
    // Catching a feature task up to the PROJECT branch would drag in work the
    // feature deliberately isn't built on yet.
    let syncNote = "";
    const base = taskBaseBranch(task, project);
    const caught = await catchUpWorktree(project, task, base);
    if (caught.caughtUp) {
      if (caught.baseTip) {
        task.base_sha = caught.baseTip;
        updateTask(id, { base_sha: caught.baseTip });
      }
      syncNote = `✓ Caught up to ${base} (was ${caught.behind} behind).`;
    }
    const userMsg = addMessage(id, gen, "user", userText);
    updateTask(id, { running: 1, suggested: 0, awaiting_input: 0 });
    publish(id, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen });
    startTurn(task, project, userText, syncNote, abortController);
  } catch (err) {
    // The turn never launched (e.g. the task row vanished mid-await) — release
    // the claim, or the task would read "running" forever and every future
    // message would queue into the void. Identity-guarded, so if the runner
    // did take ownership this is a no-op.
    unregisterTurn(id, abortController);
    throw err;
  }
}

/**
 * Persist + publish a failed-turn line, appending a recovery hint when the
 * failure is one we know how to fix:
 *   - the API's context-overflow rejection ("prompt is too long") →
 *     CONTEXT_OVERFLOW_NOTICE, which the UI turns into a one-click "Start fresh
 *     context" (/clear) button;
 *   - a dead agent login (expired OAuth session, revoked/invalid key) →
 *     AUTH_EXPIRED_NOTICE, which becomes a "Reconnect <agent>" button;
 *   - a spent usage limit (Claude's 5-hour/weekly subscription cap, an API 429)
 *     → USAGE_LIMIT_NOTICE, informational — the recovery is waiting for the
 *     reset, so there is no button.
 * Either way the raw provider text stays visible above the hint, so token counts
 * and the actual wording remain legible. The persisted message is the durable
 * channel — it survives SSE reconnects because the snapshot replays from SQLite.
 */
export function publishTurnError(id: string, gen: number, errText: string): void {
  const notice = isPromptTooLong(errText)
    ? CONTEXT_OVERFLOW_NOTICE
    : isAuthFailure(errText)
      ? AUTH_EXPIRED_NOTICE
      : isUsageLimit(errText)
        ? USAGE_LIMIT_NOTICE
        : null;
  const content = notice ? `⚠ ${errText}\n\n${notice}` : `⚠ ${errText}`;
  // The persist can itself throw — most importantly when the task row is gone
  // (project/task deleted mid-turn): addMessage then hits a FOREIGN KEY error.
  // This function is the *error* path, so a throw here escapes the runner's
  // catch block and, unhandled on the detached `run()`, would crash the whole
  // server. Degrade gracefully: if we can't persist, still fan out to any live
  // viewer with a best-effort id, and never rethrow.
  let msgId: string | undefined;
  try {
    msgId = addMessage(id, gen, "system", content).id;
  } catch (err) {
    console.error(`[runner] could not persist turn error for task ${id} (row gone?):`, err);
  }
  try {
    publish(id, { type: "error", content, msgId, generation: gen });
  } catch {
    // in-memory pub/sub; ignore
  }
}

async function run(task: Task, project: Project, userText: string, syncNote: string, abortController: AbortController): Promise<void> {
  const id = task.id;
  const gen = task.generation;
  let sessionId: string | null = task.session_id;
  let opened = false;
  // tool_use_id -> { dbId, data } so a later tool_result can be merged in.
  const toolMsgs: Record<string, { dbId: string; data: ToolData }> = {};
  // Asks still awaiting an answer — one assistant message can park several at
  // once, and awaiting_input must stay up until the last one is answered.
  const openAsks = new Set<string>();
  // Analytics: this turn's spend (from the usage event) + failure state, both
  // attached to the terminal turn_completed / turn_failed event below.
  let turnUsage: TurnUsage | null = null;
  let turnError: string | null = null;
  // Set when this turn died on authentication rather than on the work: the
  // agent's login is dead instance-wide, so the queue must be parked (every
  // follow-up would fail identically) and the whole app told, not just this task.
  let authFailure: string | null = null;
  // Set when this turn died on a spent usage limit (Claude's 5-hour/weekly
  // subscription cap, an API 429): the quota is dead until it resets, so the
  // queue must be parked for the same reason — every follow-up would drain
  // straight into the same limit. Classified after authFailure (a dead login
  // never doubles as a spent quota).
  let usageLimitFailure: string | null = null;
  // The business-facing outcome line this turn reported, if it reported one (see
  // extractOutcome). Collected as messages stream but written once, in the settle
  // below, so a turn that reports and then keeps working costs no extra writes.
  let outcome = "";
  const startedAt = Date.now();

  // Persist + publish a failed turn's transcript line (with a recovery hint when
  // we know the fix), and — for a dead login — raise the instance-wide flag every
  // tab reads, published once per outage so a fleet of failing tasks can't spam
  // the banner. Returns true when the failure was an authentication failure, so
  // the caller records it for the queue decision below.
  const failTurn = (text: string): boolean => {
    publishTurnError(id, gen, text);
    if (!isAuthFailure(text)) return false;
    if (markAgentAuthBroken(task.agent, text, Date.now())) {
      publish(id, { type: "agent_auth", agent: task.agent, broken: true, reason: text });
    }
    return true;
  };
  try {
    // The setup below runs INSIDE the try on purpose: a throw here (SQLite I/O
    // error, disk full) must still hit the finally, or the turn never
    // unregisters and running never settles — the task would show "running"
    // forever and its queued follow-ups would never drain.
    //
    // Funnel: the first-ever turn on this instance (tutorial included — `seeded`
    // tells them apart). The settings flag makes it exactly-once across restarts.
    if (!getSetting("first_task_started")) {
      setSetting("first_task_started", String(startedAt));
      track("first_task_started", { task_id: id, project_id: project.id, seeded: !!project.seeded });
    }
    track("turn_started", {
      task_id: id,
      project_id: project.id,
      generation: gen,
      resume: !!task.session_id,
      model: task.model || null,
    });

    if (syncNote) {
      const m = addMessage(id, gen, "system", syncNote);
      publish(id, { type: "notice", content: syncNote, msgId: m.id, generation: gen });
    }
    for await (const ev of getDriver(task.agent).runTurn(task, project, userText, abortController)) {
      // Persist first, then publish enriched with the DB message id — so a
      // snapshot taken at any instant plus the live tail never loses an event,
      // and clients can upsert by id instead of appending duplicates.
      if (ev.type === "session") {
        sessionId = ev.sessionId;
        opened = true;
        // Session is live — now it's officially started / in progress.
        updateTask(id, { started: 1, status: "in_progress" });
        // Persist this generation's agent session id for the project view.
        recordSession({ project_id: project.id, task_id: id, generation: gen, claude_session_id: sessionId });
        publish(id, ev);
      } else if (ev.type === "model") {
        // Persist the model the SDK actually ran so the badge survives reloads.
        updateTask(id, { resolved_model: ev.model });
        publish(id, ev);
      } else if (ev.type === "assistant") {
        const m = addMessage(id, gen, "assistant", ev.content);
        // Latest report wins — a turn that finishes twice (fix, then follow-up
        // fix) should leave the card describing where it actually ended up.
        const reported = extractOutcome(ev.content);
        if (reported) outcome = reported;
        publish(id, { ...ev, msgId: m.id, generation: gen });
      } else if (ev.type === "tool") {
        const data = toolData(ev);
        const m = addMessage(id, gen, "tool", JSON.stringify(data));
        toolMsgs[ev.id] = { dbId: m.id, data };
        publish(id, { ...ev, msgId: m.id, generation: gen });
      } else if (ev.type === "tool_result") {
        const t = toolMsgs[ev.id];
        if (t) {
          t.data.result = ev.content;
          t.data.isError = ev.isError;
          if (ev.peek) t.data.peek = ev.peek;
          updateMessage(t.dbId, JSON.stringify(t.data));
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        }
      } else if (ev.type === "ask") {
        // Persist the question (with its id) so a page reload can re-render
        // the picker and still answer the correct tool_use.
        const data: ToolData = { title: "Question for you", ask: { id: ev.id, questions: ev.questions } };
        const m = addMessage(id, gen, "tool", JSON.stringify(data));
        toolMsgs[ev.id] = { dbId: m.id, data };
        openAsks.add(ev.id);
        // The turn is still live but parked on the user — flag it so the task
        // list / project badges surface "Needs your input" right now, not only
        // once the turn fully ends. Persisted BEFORE publishing so reloads and
        // the global /api/events stream (which re-reads the row per event) agree.
        updateTask(id, { awaiting_input: 1 });
        publish(id, { ...ev, msgId: m.id, generation: gen });
      } else if (ev.type === "ask_answered") {
        const t = toolMsgs[ev.id];
        if (t) {
          t.data.ask = { id: t.data.ask?.id ?? ev.id, questions: t.data.ask?.questions ?? [], answers: ev.answers };
          updateMessage(t.dbId, JSON.stringify(t.data));
          // Answered — but only drop the flag once every parked ask is settled;
          // Claude resumes work in the same turn once none are waiting. (A
          // later turn-end re-flags it via the finally block.)
          openAsks.delete(ev.id);
          if (openAsks.size === 0) updateTask(id, { awaiting_input: 0 });
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        }
      } else if (ev.type === "usage") {
        addUsage({ project_id: project.id, task_id: id, generation: gen, agent: task.agent, usage: ev.usage });
        turnUsage = ev.usage;
        publish(id, ev);
      } else if (ev.type === "error") {
        // A soft error emitted mid-stream (e.g. "Run ended: …"). Marks the turn
        // failed for analytics and publishes the persisted form, so live viewers
        // and snapshot replays render the identical line (with a recovery hint
        // on context overflow / a dead login).
        turnError = ev.content;
        if (failTurn(ev.content)) authFailure = ev.content;
        else if (isUsageLimit(ev.content)) usageLimitFailure = ev.content;
      } else if (ev.type === "notice") {
        // A quiet system note emitted mid-turn (e.g. expose_service confirming a
        // live URL). Persist it so a reload still shows the line, like syncNote.
        const m = addMessage(id, gen, "system", ev.content);
        publish(id, { ...ev, msgId: m.id, generation: gen });
      } else if (ev.type === "done") {
        sessionId = ev.sessionId;
        publish(id, ev);
      } else {
        publish(id, ev);
      }
    }
  } catch (err) {
    // Persisted (not just streamed): with no request attached, nobody may be
    // listening when this fires — the transcript must carry it.
    turnError = err instanceof Error ? err.message : String(err);
    if (failTurn(turnError)) authFailure = turnError;
    else if (isUsageLimit(turnError)) usageLimitFailure = turnError;
  } finally {
    // NOTE: this whole block is synchronous (better-sqlite3, in-memory pub/sub),
    // so nothing can interleave with it — the registry slot is either handed off
    // or released below, never left in a half-state a POST could race.
    //
    // A Stop deletes our registry entry immediately (hasTurn goes false), so a
    // new POST can claim the slot and start a successor turn while this one is
    // still unwinding. When that has happened, the successor owns the task row,
    // the pending queue, and turn_end — settling any of them here would clobber
    // a live turn's state (running flipped off, its queued follow-ups eaten).
    const superseded = hasTurn(id) && !ownsTurn(id, abortController);
    // Terminal analytics for the funnel + per-task cost. A Stop isn't a failure
    // (Claude swallows the abort), so it reports as a completed-but-stopped turn.
    const stopped = abortController.signal.aborted;
    const base = {
      task_id: id,
      project_id: project.id,
      generation: gen,
      duration_ms: Date.now() - startedAt,
    };
    if (turnError && !stopped) {
      track("turn_failed", { ...base, error: turnError.slice(0, 500) });
    } else {
      track("turn_completed", {
        ...base,
        stopped,
        cost_usd: turnUsage?.cost_usd ?? 0,
        input_tokens: turnUsage?.input_tokens ?? 0,
        output_tokens: turnUsage?.output_tokens ?? 0,
        cache_read_tokens: turnUsage?.cache_read_tokens ?? 0,
        cache_creation_tokens: turnUsage?.cache_creation_tokens ?? 0,
      });
    }
    // Guard against a generation boundary crossed mid-turn (a /clear while this
    // turn was live). /clear ends this generation and resets the task row —
    // session_id=null, started=0, running=0 — for a fresh context. If we then
    // wrote our sessionId back here we'd RESURRECT the session /clear just
    // nulled and re-arm running/awaiting_input, silently defeating /clear and
    // double-injecting the old context on the next send. So only settle the
    // task row when it's still on the generation this turn actually ran in.
    const current = getTask(id);
    const generationAdvanced = !current || current.generation !== gen;
    // If the session never opened, keep the task retryable (started stays 0).
    // A turn that actually ran and ended mid-task — whether it finished on its
    // own or was Stopped — is now waiting on the user, so flag awaiting_input
    // (cleared on the next send / done) leaving it cleanly resumable.
    if (!generationAdvanced && !superseded) {
      // Only written when this turn reported one: a turn that says nothing must
      // not blank the outcome an earlier turn already earned.
      updateTask(id, { running: 0, session_id: sessionId, awaiting_input: opened ? 1 : 0, ...(outcome ? { outcome } : {}) });
    }
    // Keyed by (task_id, generation), so this settles THIS generation's session
    // row and never touches the fresh generation — safe to run either way.
    if (opened) endSession(id, gen);

    // A turn that actually ran is the strongest possible proof the agent's login
    // works — stronger than `claude auth status`, since it exercised the same
    // path a real turn takes. So clear any broken-connection flag left by an
    // earlier failure and tell every tab, which is how the banner comes down
    // after the user reconnects in a different window (or the credential
    // refreshed itself). Publishes only when the flag was actually set.
    if (!turnError && opened && clearAgentAuthBroken(task.agent)) {
      publish(id, { type: "agent_auth", agent: task.agent, broken: false, reason: null });
    }

    // A Stop — or a /clear that advanced the generation out from under us —
    // discards the parked queue: those follow-ups were lined up behind the train
    // of thought the user just interrupted (or the context they just cleared),
    // so running them now would be surprising and would leak old-generation
    // work into the new one. Otherwise dequeue the oldest follow-up and run it
    // as the next turn, continuing the session without a gap.
    let continued = false;
    if (superseded) {
      // The successor turn owns the queue and will emit its own turn_end; our
      // own registry entry is long gone (the Stop deleted it), so there is
      // nothing left to release either.
      continued = true;
    } else if (abortController.signal.aborted || generationAdvanced) {
      for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });
    } else if (authFailure || usageLimitFailure) {
      // The login (or the quota) is dead, not the work: draining now would run
      // each follow-up straight into the same authentication error / spent
      // limit, emptying the queue and stacking identical walls of red for
      // messages that never actually ran. Leave them parked (they're rows in
      // pending_messages, so they survive a reload and still render as queued
      // bubbles) and say so once. They drain normally at the end of the next
      // turn, after a reconnect / once the limit resets.
      const parked = listPendingMessages(id).length;
      if (parked) {
        const when = authFailure ? "once you reconnect" : "once the limit resets";
        const note = `ℹ ${parked} queued message${parked === 1 ? "" : "s"} kept in the queue — ${parked === 1 ? "it runs" : "they run"} ${when}.`;
        const m = addMessage(id, gen, "system", note);
        publish(id, { type: "notice", content: note, msgId: m.id, generation: gen });
      }
    } else {
      // Hand the occupancy slot to the follow-up FIRST — an atomic swap of our
      // controller for a fresh one — so hasTurn never reads false between this
      // turn and the next. (It used to: unregister-then-launch left a window
      // where a POST could start a parallel turn against the same session.)
      const nextController = handoffTurn(id, abortController);
      if (nextController) {
        const next = popPendingMessage(id);
        const fresh = next ? getTask(id) : undefined;
        // Re-read the project at dequeue time, not the snapshot captured at the
        // START of the turn we're finishing. The base branch, repo_path, or
        // context may have changed while this turn ran; the dequeued follow-up
        // fast-forwards against project.branch/repo_path and seeds its system
        // prompt from project.context, so a stale snapshot would sync it to the
        // wrong base and run it with outdated context.
        const freshProject = fresh ? getProject(fresh.project_id) : undefined;
        if (next && fresh && freshProject) {
          // Drop its "queued" bubble — startResumeTurn re-echoes it as a normal
          // user message. running stays on across the handoff, so we deliberately
          // do NOT publish turn_end here; the next turn's own finally will.
          publish(id, { type: "dequeued", msgId: next.id });
          continued = true;
          // The follow-up writes into the same worktree the merge/sync routes
          // rewrite with multi-second git ops, so launch under the same
          // per-task lock those routes hold — and re-check the world once we
          // have it, because the wait can be long. The handoff slot above
          // stays claimed the whole time, so no POST can start a parallel
          // turn while we queue for the lock.
          void withTaskLock(id, async () => {
            const cur = getTask(id);
            // Task deleted or /clear'd while we waited — a cleared generation
            // discards its queue, and this popped message belongs to the old
            // one. (Their abortTurn already released the handoff slot; the
            // unregister is a defensive no-op then.)
            if (!cur || cur.generation !== gen) {
              unregisterTurn(id, nextController);
              return;
            }
            // Re-read the project too: it was already refreshed at dequeue time
            // (see freshProject above), but the lock wait can be long — a merge
            // may have run, or the project may have been deleted, in between.
            const curProject = getProject(cur.project_id);
            if (!curProject) {
              unregisterTurn(id, nextController);
              publishTurnError(id, gen, "Project was deleted; queued follow-up cancelled.");
              publish(id, { type: "turn_end" });
              return;
            }
            if (!ownsTurn(id, nextController)) {
              // A Stop landed while we waited on the lock: it tripped and
              // released the handoff slot (and a successor turn may have
              // claimed it since). Stop discards queued follow-ups, so drop
              // this one — it was parked before the press. With no successor,
              // settle the UI with the turn_end the handoff had deferred; a
              // live successor emits its own.
              if (!hasTurn(id)) publish(id, { type: "turn_end" });
              return;
            }
            await startResumeTurn(cur, curProject, next.content, nextController);
          }).catch((err) => {
            // Failsafe: if launching the queued turn fails, release its slot,
            // surface the error, and settle the task so it doesn't hang in a
            // running-but-dead state.
            unregisterTurn(id, nextController);
            const content = `⚠ ${err instanceof Error ? err.message : String(err)}`;
            const m = addMessage(id, gen, "system", content);
            publish(id, { type: "error", content, msgId: m.id, generation: gen });
            updateTask(id, { running: 0, awaiting_input: opened ? 1 : 0 });
            publish(id, { type: "turn_end" });
          });
        } else {
          if (next && fresh && !freshProject) {
            // Project was deleted mid-turn: with no base branch / repo_path /
            // context left, the follow-up can't be safely synced or run. Drop
            // its "queued" bubble, surface the cancellation, and fall through
            // to the turn_end below (continued stays false) leaving the task
            // settled.
            publish(id, { type: "dequeued", msgId: next.id });
            publishTurnError(id, gen, "Project was deleted; queued follow-up cancelled.");
          }
          // Nothing queued, or the task/project row is gone — free the slot we
          // just claimed for the handoff.
          unregisterTurn(id, nextController);
        }
      }
    }
    if (!continued) {
      // Release occupancy only now, at the very end of this synchronous block —
      // a no-op if a Stop already deleted the entry or a handoff replaced it.
      unregisterTurn(id, abortController);
      // Emitted after the task row settles, so a client refreshing on turn_end
      // reads the final running/awaiting_input state. Skipped when a queued
      // follow-up or a successor turn is taking over — that turn will emit its
      // own turn_end.
      publish(id, { type: "turn_end" });
    }
  }
}
