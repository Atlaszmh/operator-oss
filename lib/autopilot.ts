// The autopilot controller — the thing that walks an approved plan so the user
// doesn't have to.
//
// Everything in here is something the user could already do by hand today: start
// a task, run the tests, read the diff, merge the branch, open a PR. Autopilot
// just does them without being asked, and — this is the important half — stops
// the moment it can't. There are exactly two places a human is required: the
// plan approval that turns this on, and the PR it ends at.
//
// Driven by EVENTS, not a timer. subscribeGlobal() already broadcasts turn_end
// for every task in every project, and a turn ending is precisely the moment
// there is new work to consider; polling would burn cycles to learn nothing. A
// slow safety sweep (on the recap sweep's cadence) covers the one case events
// can't: a server restart with a queue mid-flight.
//
// sweep() is idempotent and serialized per project, so the two triggers
// overlapping is harmless.

import {
  syncFeaturesToBase,
  syncTasksToBase,
  catchUpWorktree,
  publishProjectBranch,
  fileLandResolutionTask,
  isResolutionTask,
} from "./featureSync";
import {
  getProject,
  getFeature,
  getTask,
  listFeatures,
  listProjects,
  updateTask,
  updateFeature,
  addMessage,
  recordTaskMerge,
  taskBaseBranch,
  featureMembers,
  readyMembers,
  getRateLimits,
  getTaskDeps,
} from "./store";
import { startInitialTurn, startResumeTurn } from "./runner";
import { runGate, gateIsAdvisory, runFeatureGate, featureGateFailure, runTestsIn } from "./gates";
import { mergeTask, fastForwardWorktree, worktreeSyncStatus } from "./git";
import { createBranchPr, buildFeaturePrBody } from "./github";
import { buildConflictPrompt } from "./agents/shared";
import { subscribeGlobal, publishGlobal, publish } from "./events";
import { hasTurn } from "./abort";
import { workStarted, workEnded } from "./idle";
import { resolveFeatures } from "./features";
import { AUTOPILOT_CONCURRENCY, AUTOPILOT_ATTEMPTS, GATE_TEST_TIMEOUT_MS } from "./config";
import type { Feature, GateVerdict, Project, Task } from "./types";
import { trace, traceWarn, secs } from "./trace";

/**
 * How long a task may sit with a gate that can't reach a verdict before
 * autopilot gives up waiting and escalates it. Derived from the project's own
 * test timeout rather than being a knob of its own: three whole gate windows
 * with nothing to show is not a slow suite, it's a reviewer that isn't coming
 * back.
 */
export const GATE_STALL_MS = GATE_TEST_TIMEOUT_MS * 3;

/**
 * How many times one sweep may re-loop on its own dirty flag before handing the
 * rest to the next sweep. Generous — a legitimate chain (a member lands, its
 * dependent starts, that one lands) re-loops a handful of times — and only ever
 * reached by a pass that keeps re-dirtying the project without making progress.
 */
const MAX_SWEEP_PASSES = 12;

/**
 * How long autopilot waits before picking up a task it parked on a TRANSIENT
 * failure — one about the machinery rather than the work (a reviewer that
 * couldn't run, an exhausted usage window, a worktree it couldn't claim).
 *
 * A parked task is invisible to BOTH halves of the loop: readyMembers skips it
 * and isSettledForGating skips it. So before this existed, a reviewer outage
 * lasting minutes cost the whole feature until a human noticed and typed
 * something — five members parked inside half an hour on one outage, and the
 * queue sat dead overnight. Long enough not to hammer a real outage, short
 * enough that a queue heals itself inside a coffee break.
 */
export const TRANSIENT_RETRY_MS = 10 * 60 * 1000;

/**
 * The backoff for a member parked behind a conflict RESOLVER task. Longer than
 * the generic one because what it is waiting for is another task's entire
 * lifecycle (start → work → gate → merge); retrying sooner just pays for a
 * fresh review to rediscover the same conflict.
 */
export const CONFLICT_HANDOFF_RETRY_MS = 30 * 60 * 1000;

/**
 * The subscription window that is currently refusing turns, if any.
 *
 * The driver already records every rate_limit_event it sees (recordRateLimit),
 * so this is a read of state we hold rather than a new probe. While a window is
 * shut, an autopilot pass can only convert quota it does not have into burnt
 * gate attempts and escalations that say "the review could not run" — so the
 * pass declines to run at all and the heartbeat picks it back up once the
 * window resets. That is what "moves whenever usage is available" means: the
 * queue waits for the reset instead of spending its retry budget on it.
 */
export function usageBlockedUntil(): number {
  let until = 0;
  for (const w of Object.values(getRateLimits())) {
    if (w.status !== "rejected") continue;
    // resetsAt is the provider's epoch SECONDS, not millis.
    const resets = (w.resetsAt ?? 0) * 1000;
    if (resets > Date.now()) until = Math.max(until, resets);
  }
  return until;
}

declare global {
  // eslint-disable-next-line no-var
  var __orchAutopilot:
    | {
        armed: boolean;
        running: Set<string>;
        again: Set<string>;
        usageNotedUntil: number;
        waiters: Map<string, (() => void)[]>;
      }
    | undefined;
}

// HMR-surviving controller state, same pattern as lib/events.ts / lib/abort.ts.
function state() {
  if (!global.__orchAutopilot)
    global.__orchAutopilot = {
      armed: false,
      running: new Set(),
      again: new Set(),
      usageNotedUntil: 0,
      waiters: new Map(),
    };
  return global.__orchAutopilot;
}

/**
 * Resolves when something happens that could give the IN-FLIGHT pass new work.
 *
 * The gating loop would otherwise only re-check for newly-settled members when
 * one of its own gates finished — so a task that handed back thirty seconds
 * into someone else's 20-minute review still waited out that review. A pass
 * already learns about new work (a concurrent sweep() marks the project dirty);
 * this just lets it be woken by that instead of discovering it later.
 */
function dirtySignal(projectId: string): Promise<"dirty"> {
  const st = state();
  return new Promise((resolve) => {
    const list = st.waiters.get(projectId) ?? [];
    list.push(() => resolve("dirty"));
    st.waiters.set(projectId, list);
  });
}

function wakeWaiters(projectId: string): void {
  const st = state();
  const waiting = st.waiters.get(projectId);
  if (!waiting?.length) return;
  st.waiters.delete(projectId);
  for (const w of waiting) w();
}

/**
 * Arm the event subscription. Idempotent and cheap, so every entry point that
 * could plausibly be the first thing to happen after a boot calls it: the
 * approve-plan route, the always-open /api/events stream, and the recap sweep.
 *
 * "Arm on first touch" rather than a boot hook because there isn't one available
 * to us — server.js is plain CommonJS and can't import this file.
 */
export function ensureAutopilot(): void {
  const st = state();
  if (st.armed) return;
  st.armed = true;
  subscribeGlobal((taskId, ev) => {
    // Every event that can leave a dependent ready, not just turn_end.
    //
    // turn_end is the usual one. But a task stops blocking its dependents on
    // three OTHER events that were all being dropped here: a status set to done
    // or cancelled by hand, a hard delete (task_dependencies is ON DELETE
    // CASCADE, so deleting a blocker really does unblock what it blocked), and
    // — the expensive one — land()'s own task_updated when autopilot merges a
    // member. sweepOnce walks a project's features in order, so a task landing
    // in feature 3 cannot reach a dependent sitting in feature 1: that feature's
    // pass already happened this sweep. Nothing marked the project dirty, the
    // pass ended, and the dependent waited on the 60s heartbeat to be told about
    // work that had been ready since the merge.
    //
    // Sweeping on these makes the in-flight pass loop once more (sweep()'s
    // `again` set) — which IS the "your blocker is done" signal, delivered at
    // the moment the blocker finished rather than at the next tick. Bounded: a
    // pass with nothing left to do publishes nothing, so the loop stops.
    const type = (ev as { type?: string }).type;
    if (type !== "turn_end" && type !== "task_updated" && type !== "task_deleted") return;
    // A deleted task has no row left to read, so the event carries its project.
    const projectId =
      type === "task_deleted" ? (ev as { projectId: string }).projectId : getTask(taskId)?.project_id;
    // Any turn can be the one that files new work, not just a member's: a
    // planning task is normally ungrouped, and its suggest_task calls are
    // exactly what an armed feature is waiting for. Filtering on feature_id
    // meant a plan landed in the tray and nothing came to collect it. A sweep
    // for a project with no armed feature is one indexed query and a return.
    if (!projectId) return;
    // The wake itself is timeline-worthy: when a queue looks hung, the first
    // question is always "did the signal even arrive?", and only a line here
    // can answer it. Guarded so projects with nothing armed stay silent.
    if (hasArmedFeature(projectId)) trace("autopilot", `WAKE ${type} task=${taskId} project=${projectId}`);
    void sweep(projectId).catch(() => {});
  });
}

/** Cheap "is autopilot even watching this project" check, for log guards. */
function hasArmedFeature(projectId: string): boolean {
  return listFeatures(projectId).some((f) => f.autopilot && !f.archived);
}

/**
 * One idempotent pass over a project's autopilot features.
 *
 * Serialized per project: a second caller doesn't run concurrently (two passes
 * racing would both see the same task as "ready" and start it twice), it marks
 * the project dirty so the in-flight pass loops once more before returning.
 */
export async function sweep(projectId: string): Promise<void> {
  if (!resolveFeatures().autopilot) return;
  // Usage is shut: starting turns and running reviewers would both fail, and
  // failing them charges the tasks for an outage. Wait for the reset — the
  // heartbeat is already asking every minute, so nothing needs to schedule this.
  const shutUntil = usageBlockedUntil();
  if (shutUntil) {
    const st0 = state();
    if (st0.usageNotedUntil !== shutUntil) {
      st0.usageNotedUntil = shutUntil;
      trace("autopilot", `USAGE-PAUSED until ${new Date(shutUntil).toISOString()} — not starting or gating anything until then`);
    }
    return;
  }
  const st = state();
  if (st.usageNotedUntil) {
    st.usageNotedUntil = 0;
    trace("autopilot", "USAGE-OK — resuming");
  }
  if (st.running.has(projectId)) {
    // Piling up behind an in-flight pass is normal and safe (the pass re-loops),
    // but it IS the shape of "everything waited on one slow gate", so say it
    // once per in-flight sweep rather than for every event that lands.
    if (!st.again.has(projectId) && hasArmedFeature(projectId))
      trace("autopilot", `DEFERRED project=${projectId} — a sweep is already running; it will re-loop`);
    st.again.add(projectId);
    // …and tell that pass now, so a member that just handed back is gated
    // immediately rather than when some other member's review happens to end.
    wakeWaiters(projectId);
    return;
  }
  st.running.add(projectId);
  // Count the queue as live work so the idle daemon can't stop the container
  // between two tasks of a running plan.
  workStarted();
  let cappedOut = false;
  try {
    // The re-loop is bounded because a pass can now dirty its OWN project:
    // autopilot's mutations publish task_updated for the UI, and that publish is
    // also the signal that tells dependents their blocker is done. Most re-loops
    // are exactly what we want. But a pass that isn't idempotent re-dirties the
    // project every time — maybeOpenPr re-escalating a feature gate that keeps
    // failing spun here 10k+ times — so cap it and let the heartbeat own whatever
    // is still outstanding. Never silently: a project that hits the cap says so.
    const t0 = Date.now();
    let passes = 1;
    do {
      st.again.delete(projectId);
      await sweepOnce(projectId);
    } while (st.again.has(projectId) && passes++ < MAX_SWEEP_PASSES);
    if (st.again.has(projectId)) {
      cappedOut = true;
      traceWarn(
        "autopilot",
        `SWEEP-CAP project=${projectId} still dirty after ${MAX_SWEEP_PASSES} passes — remainder handed to the heartbeat`
      );
    }
    // Only slow sweeps log — the no-op sweep that follows every event on every
    // project is single-digit milliseconds and would be pure noise.
    const took = Date.now() - t0;
    if (took > 1000) trace("autopilot", `SWEEP-END project=${projectId} passes=${passes} in ${(took / 1000).toFixed(1)}s`);
  } finally {
    st.running.delete(projectId);
    // A signal that landed while this pass was unwinding — after the loop's
    // last `again` check but before the slot was released — used to be thrown
    // away here, because a concurrent caller can only mark the project dirty
    // and this line then cleared the mark. The wake-ups are edge-triggered, so
    // a dropped one waits out the 60s heartbeat with everything it unblocked
    // sitting idle. Re-arm instead of dropping.
    //
    // Never after the cap fired, though: a pass that re-dirties its own project
    // every time would then loop forever with no bound (one did — see above).
    // That remainder stays the heartbeat's, which is exactly what the cap means.
    const pending = st.again.delete(projectId);
    workEnded();
    if (pending && !cappedOut) setTimeout(() => void sweep(projectId).catch(() => {}), 0).unref?.();
  }
}

async function sweepOnce(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  for (const f of listFeatures(projectId)) {
    if (!f.autopilot || f.archived) continue;
    const feature = getFeature(f.id);
    if (!feature) continue;
    try {
      await driveFeature(project, feature);
    } catch (e) {
      // One wedged feature must never abort the sweep for the others — the same
      // best-effort rule sweepRecaps() follows.
      traceWarn("autopilot", `PASS-ERROR feature=${feature.id}: ${(e as Error).message}`);
    }
  }
}

async function driveFeature(project: Project, feature: Feature): Promise<void> {
  // 0. On an armed feature a suggestion IS the plan, so accept it. Approving is
  //    an act with a duration, not an instant: the planner may still be filing,
  //    and a member that discovers follow-up work files it the same way. Left
  //    suggested, that work is invisible to BOTH halves of the loop —
  //    readyMembers skips suggestions and maybeOpenPr doesn't count them — so
  //    the feature would sail past it and open a PR with the work still in the
  //    tray. Accepting here is the one rule that makes plan → build → review one
  //    unbroken run.
  for (const t of featureMembers(feature.id)) {
    if (!t.suggested) continue;
    updateTask(t.id, { suggested: 0 });
    note(t, "✓ Autopilot accepted this suggested task — this feature's plan is already approved.");
    publishGlobal(t.id, { type: "task_updated" });
  }

  // 0.5 Un-park anything autopilot stopped for a TRANSIENT reason whose backoff
  //     has elapsed. A parked task is invisible to both halves of the loop, so
  //     an outage that has since cleared would otherwise hold the feature until
  //     a human typed something. Terminal blocks (gate_retry_at 0) are a
  //     judgement about the WORK and stay the human's — untouched here.
  for (const t of featureMembers(feature.id)) {
    if (!t.blocked_reason || !t.gate_retry_at || t.gate_retry_at > Date.now()) continue;
    updateTask(t.id, { blocked_reason: "", awaiting_input: 0, gate_retry_at: 0 });
    trace("autopilot", `UNPARK task=${t.id} — backoff elapsed, retrying`);
    note(t, "↻ Autopilot is picking this back up — what stopped it was a temporary failure, not the work.");
    publishGlobal(t.id, { type: "task_updated" });
  }

  // 1 + 2. Start what can start, then gate what has finished — CONTINUOUSLY,
  //        not as two batched phases.
  //
  //        Starting is the cheap half (claim + worktree + title); a gate is
  //        minutes of tests plus a reviewer turn. Gating first meant a task
  //        whose blocker landed on a previous pass sat startable behind every
  //        other member's gate — 16 minutes of dead air with free slots the
  //        whole time, measured. And collecting the settled set ONCE meant a
  //        task that finished thirty seconds into a pass waited for every gate
  //        already in flight to drain before its own could even begin; with
  //        reviews running 8-20 minutes on a real project, that is most of the
  //        latency the user actually feels.
  //
  //        So: gates are launched as members settle, each verdict is applied
  //        the moment it arrives (landings stay serial — they share the
  //        integration branch), and starting is re-checked right after every
  //        verdict, so a merge that unblocks a dependent starts it immediately
  //        rather than on the next pass.
  await startReady(project, feature);

  // Gated once per pass each: applyVerdict deliberately leaves an inconclusive
  // task untouched (so it retries on the NEXT sweep, uncharged), which without
  // this would make it instantly re-eligible and spin the loop forever.
  const gatedThisPass = new Set<string>();
  const inFlight = new Map<string, Promise<readonly [Task, GateVerdict]>>();
  for (;;) {
    for (const t of featureMembers(feature.id).filter(isSettledForGating)) {
      if (inFlight.has(t.id) || gatedThisPass.has(t.id)) continue;
      gatedThisPass.add(t.id);
      inFlight.set(t.id, gateOne(project, feature, t));
    }
    if (!inFlight.size) break;
    // Woken by whichever comes first: a verdict, or news that the project has
    // new work worth re-scanning for.
    const winner = await Promise.race([...inFlight.values(), dirtySignal(project.id)]);
    if (winner === "dirty") continue;
    const [t, verdict] = winner;
    inFlight.delete(t.id);
    await applyVerdict(project, feature, t, verdict);
    await startReady(project, feature);
  }

  // 3. Everything landed → hand the feature back to the user as a PR.
  await maybeOpenPr(project, feature);

  // 4. Say where the feature now stands. A hang is BY DEFINITION the absence of
  //    events, so a log that only records actions can never explain one — this
  //    is the line that does, and when nothing can move it names every
  //    outstanding member and what it is waiting for.
  reportDisposition(feature);
}

/**
 * One timeline line per feature per pass, and the full reason when it's stuck.
 *
 * "Stalled" is deliberately about MOVEMENT, not completeness: outstanding work
 * with nothing running, nothing gating and nothing startable. That is the state
 * the user experiences as "it just hung", and every cause of it (a member
 * blocked on a human, a dependency that never landed, a plan still sitting in
 * the tray unapproved) is named per member so the next question is answerable
 * from the log alone.
 */
function reportDisposition(feature: Feature): void {
  const members = featureMembers(feature.id);
  const isDone = (t: Task) => t.status === "done" || t.status === "cancelled";
  const running = members.filter((t) => t.running || hasTurn(t.id));
  const gating = members.filter(isSettledForGating);
  const parked = members.filter((t) => t.blocked_reason && t.gate_retry_at);
  const blocked = members.filter((t) => t.blocked_reason && !t.gate_retry_at);
  const suggested = members.filter((t) => t.suggested);
  const ready = readyMembers(feature.id).filter((t) => !t.started);
  const done = members.filter(isDone);

  const summary =
    `feature="${feature.name}" ${members.length} members: ${done.length} done, ${running.length} running, ` +
    `${gating.length} gating, ${ready.length} ready, ${parked.length} parked(auto-retry), ` +
    `${blocked.length} blocked(needs you), ${suggested.length} suggested`;

  const outstanding = members.filter((t) => !isDone(t) && !t.suggested);
  const moving = running.length + gating.length + ready.length;
  if (!outstanding.length || moving > 0) {
    trace("autopilot", `STATE ${summary}`);
    return;
  }

  // Nothing can move. Name every outstanding member and why.
  traceWarn("autopilot", `STALLED ${summary} — nothing can move; reasons follow`);
  for (const t of outstanding) {
    if (t.blocked_reason && !t.gate_retry_at) {
      traceWarn("autopilot", `  task=${t.id} "${t.title}" NEEDS-YOU: ${t.blocked_reason.split("\n")[0]}`);
    } else if (t.blocked_reason) {
      traceWarn("autopilot", `  task=${t.id} "${t.title}" PARKED until ${new Date(t.gate_retry_at).toISOString()}`);
    } else {
      // Not blocked and not startable can only mean an unsatisfied dependency —
      // print the blockers with their statuses, which is the whole diagnosis.
      const blockers = getTaskDeps(t.id)
        .map((id) => getTask(id))
        .filter((d): d is Task => !!d)
        .filter((d) => !isDone(d))
        .map((d) => `${d.title}=${d.status}${d.blocked_reason ? "/blocked" : ""}`);
      traceWarn(
        "autopilot",
        `  task=${t.id} "${t.title}" WAITING on ${blockers.length ? blockers.join(", ") : "(nothing — status " + t.status + ", started=" + t.started + ")"}`
      );
    }
  }
  if (suggested.length)
    traceWarn("autopilot", `  ${suggested.length} suggested task(s) need Approve plan before autopilot will run them`);
}

/**
 * Launch every member that can start right now, up to the concurrency cap.
 *
 * Settled members count as live: each is mid-pipeline (its gate is running, or
 * about to), and a failed gate becomes a feedback turn — ignoring them would
 * overshoot the cap by one per member in flight.
 */
async function startReady(project: Project, feature: Feature): Promise<void> {
  const live = featureMembers(feature.id).filter((t) => t.running || hasTurn(t.id) || isSettledForGating(t)).length;
  let slots = Math.max(0, AUTOPILOT_CONCURRENCY - live);
  if (slots <= 0) return;
  for (const t of readyMembers(feature.id)) {
    if (slots <= 0) break;
    // A started task belongs to the gating path, not to launching.
    if (t.started) continue;
    const res = await startInitialTurn(t, project);
    if (!res.ok && res.status !== 409) {
      // Launch failures are usually about the machine, not the plan (a worktree
      // that couldn't be cut, a busy repo), so this one retries itself too.
      block(t, `Autopilot could not start this task: ${res.error}`, { retryInMs: TRANSIENT_RETRY_MS });
      continue;
    }
    trace("autopilot", `START task=${t.id} "${t.title}" model=${t.model ?? "default"} feature="${feature.name}"`);
    slots--;
  }
}

/**
 * One member's gate, resolving to its verdict rather than throwing — the race
 * loop above must never be taken down by one task's failure, and a gate that
 * died tells us nothing about the diff, which is exactly `inconclusive`.
 */
async function gateOne(project: Project, feature: Feature, t: Task): Promise<readonly [Task, GateVerdict]> {
  const t0 = Date.now();
  try {
    const verdict = await runGate(t, project, feature);
    const word = verdict.inconclusive ? "inconclusive" : verdict.ok ? "pass" : "fail";
    trace("autopilot", `GATE-DONE task=${t.id} verdict=${word} in ${secs(t0)}`);
    return [t, verdict] as const;
  } catch (e) {
    traceWarn("autopilot", `GATE-THREW task=${t.id} after ${secs(t0)}: ${(e as Error).message}`);
    return [
      t,
      { ok: false, inconclusive: true, testsRan: false, reviewRan: false, feedback: `The gate threw: ${(e as Error).message}` },
    ] as const;
  }
}

/**
 * A task the gate should look at: it ran, its turn ended, nothing is working it,
 * it hasn't been escalated, and it isn't finished.
 *
 * Deliberately NOT keyed on awaiting_input any more. That flag now means "a
 * human is needed" and nothing else (see autopilotOwns in lib/store.ts) — an
 * autopilot member's turn ends with it clear, which is the whole point. The
 * facts above are what "settled" always actually meant; awaiting_input was a
 * proxy for them. Dropping the proxy also makes restart recovery strictly
 * safer: a task whose gate was interrupted is still recognisable from the row.
 */
function isSettledForGating(t: Task): boolean {
  return (
    !!t.started &&
    !t.suggested &&
    !t.running &&
    !hasTurn(t.id) &&
    !t.blocked_reason &&
    t.status !== "done" &&
    t.status !== "cancelled" &&
    t.status !== "on_hold"
  );
}

/**
 * Act on one finished task's gate verdict and, if it passed, land it. A failure
 * is a follow-up turn rather than an error: the task keeps its session and is
 * told what to fix, which is what a human reviewer would have done with the
 * same finding. (The gate itself ran in driveFeature's parallel step — this
 * half is serial because landings share the integration branch.)
 */
async function applyVerdict(project: Project, feature: Feature, task: Task, verdict: GateVerdict): Promise<void> {
  // The gate reached no verdict about the work — the reviewer itself couldn't
  // run (usage limit, no connected utility agent, a turn that died). Leave the
  // task exactly as it is: no attempt charged, no turn sent, still settled, so
  // the next sweep gates it again once the reviewer is back. Charging an outage
  // to the task blocked finished work behind it AND sent the agent an error
  // string as if it were review feedback to act on.
  //
  // Silent only while the outage is plausibly an outage. Past that the task has
  // stopped waiting for a reviewer and started being stranded — invisible, with
  // finished work in it — so it goes in front of the user with the reason. The
  // clock is the row's own updated_at, which an inconclusive pass never touches,
  // so no counter has to be stored anywhere.
  if (verdict.inconclusive) {
    if (Date.now() - task.updated_at > GATE_STALL_MS) {
      // Transient by construction: the reviewer couldn't run, which says nothing
      // about the diff. Surface it, but keep a way back that doesn't need the
      // user — the outage usually ends before they read the notice.
      block(
        task,
        `The gate has been unable to run for over ${Math.round(GATE_STALL_MS / 60000)} minutes, so autopilot stopped waiting for it. ` +
          `It will try again by itself in ${Math.round(TRANSIENT_RETRY_MS / 60000)} minutes — answering here also resumes it immediately.\n\n${verdict.feedback}`,
        { retryInMs: TRANSIENT_RETRY_MS }
      );
      return;
    }
    traceWarn(
      "autopilot",
      `GATE-INCONCLUSIVE task=${task.id} (no attempt charged, will retry): ${verdict.feedback.split("\n")[0]}`
    );
    return;
  }

  if (!verdict.ok) {
    const attempts = task.gate_attempts + 1;
    if (attempts > AUTOPILOT_ATTEMPTS) {
      block(task, `The gate failed ${AUTOPILOT_ATTEMPTS} times, so autopilot stopped retrying.\n\n${verdict.feedback}`);
      return;
    }
    updateTask(task.id, { gate_attempts: attempts });
    trace("autopilot", `GATE-FAIL task=${task.id} attempt=${attempts}/${AUTOPILOT_ATTEMPTS} — sending feedback turn`);
    await sendTurn(project, task, verdict.feedback);
    return;
  }

  // Shadow mode: the verdict is the product, the merge isn't. Record it and hand
  // back to the user rather than landing code on an uncalibrated reviewer.
  if (gateIsAdvisory()) {
    block(
      task,
      `✓ The gate PASSED, but autopilot is in shadow mode, so nothing was merged — review and merge it yourself.` +
        (verdict.feedback ? `\n\nReviewer said:\n${verdict.feedback}` : "")
    );
    return;
  }

  await land(project, feature, task);
}

async function land(project: Project, feature: Feature, task: Task): Promise<void> {
  const t0 = Date.now();
  const base = taskBaseBranch(task, project);

  if (!task.worktree_path || !task.work_branch) {
    // Nothing isolated to merge — the task ran directly in the repo (non-git or
    // empty repo), so its work is already on the base branch. Just close it out.
    updateTask(task.id, { status: "done", awaiting_input: 0, gate_attempts: 0 });
    return;
  }

  // Catch up to the branch's current tip first, so the merge is a fast-forward
  // wherever it can be.
  //
  // If the base MOVED since this task was gated, re-run the tests against the
  // caught-up tree before landing. Only the tests: the diff didn't change, the
  // ground under it did, so the reviewer has nothing new to read and the
  // expensive half is the half that can actually catch this. A no-op when the
  // base held still, and free even when it moved back to a tree already tested
  // — runTestsIn memoises on the tree sha.
  //
  // This is the "surfaces at the PR, not at the merge" bet, called in. Two
  // independently-green tasks CAN assemble into a red branch with no git
  // conflict anywhere, and when nothing runs CI on the far side, "the PR will
  // catch it" means nothing catches it.
  // The shared ladder, NOT a bare fast-forward. This was `fastForwardWorktree`
  // with its boolean dropped on the floor — which meant it did nothing at all
  // for any task that had committed work while its base moved, i.e. every task
  // in a feature running siblings concurrently. The task then gated against a
  // tree that had never seen its siblings' work and conflicted at the merge.
  const preSync = await catchUpWorktree(project, task, base);

  // Predicted or materialised conflicts: hand it to the task's OWN agent now,
  // with the base fresh, instead of gating a stale tree and discovering the same
  // conflict one merge later. Same escalation budget as a merge conflict.
  if (preSync.conflicts.length) {
    const attempts = task.gate_attempts + 1;
    if (attempts > AUTOPILOT_ATTEMPTS) {
      handOffConflict(project, feature, task, base, preSync.conflicts, `catching up to ${base}`);
      return;
    }
    updateTask(task.id, { gate_attempts: attempts });
    await sendTurn(project, task, buildConflictPrompt(base, preSync.conflicts));
    return;
  }

  if (preSync.behind > 0) {
    const retest = await runTestsIn(project, task.worktree_path);
    if (retest.ran && !retest.ok) {
      const attempts = task.gate_attempts + 1;
      if (attempts > AUTOPILOT_ATTEMPTS) {
        block(task, `\`${project.test_command}\` broke once ${base} moved underneath this task, and it was not fixed in ${AUTOPILOT_ATTEMPTS} attempts.\n\n\`\`\`\n${retest.output}\n\`\`\``);
        return;
      }
      updateTask(task.id, { gate_attempts: attempts });
      await sendTurn(
        project,
        task,
        `\`${base}\` moved while this task was waiting, and \`${project.test_command}\` now fails against the ` +
          `caught-up tree. Your own changes were green before the move, so look at what landed on ${base} ` +
          `and reconcile — do not weaken or skip the failing test.\n\n\`\`\`\n${retest.output}\n\`\`\``
      );
      return;
    }
  }

  const result = await mergeTask({
    repoPath: project.repo_path,
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch: base,
    message: `${task.title} (orchestrator task ${task.id})`,
  });

  if (!result.ok) {
    if (result.conflicts?.length) {
      const attempts = task.gate_attempts + 1;
      if (attempts > AUTOPILOT_ATTEMPTS) {
        handOffConflict(project, feature, task, base, result.conflicts, `merging into ${base}`);
        return;
      }
      updateTask(task.id, { gate_attempts: attempts });
      // Hand the conflict to the task's OWN agent as an ordinary message — the
      // exact path the client takes for a manual conflict today, moved
      // server-side. It re-gates when that turn ends.
      await sendTurn(project, task, buildConflictPrompt(base, result.conflicts));
      return;
    }
    block(task, `Merging into ${base} failed: ${result.error ?? "unknown error"}`);
    return;
  }

  updateTask(task.id, {
    status: "done",
    awaiting_input: 0,
    gate_attempts: 0,
    merged_at: Date.now(),
    ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
  });
  // Insights: line stats die with the worktree, so merge time is the only
  // chance to record them. Re-merges that landed nothing don't record.
  if (!result.alreadyMerged)
    recordTaskMerge({
      project_id: project.id,
      task_id: task.id,
      agent: task.agent,
      additions: result.additions ?? 0,
      deletions: result.deletions ?? 0,
    });
  if (!result.alreadyMerged) {
    // Sibling tasks first: they share this base and are the ones racing it.
    // Catching them up HERE is what stops the next one hitting a conflict the
    // size of the whole race rather than the size of this merge.
    await syncTasksToBase(project, base, { except: task.id });
    // Then, if what landed was the PROJECT branch, every live feature follows —
    // unattended work is exactly where silent divergence is worst, because
    // nobody is watching the branches while autopilot walks the plan.
    if (result.targetBranch === project.branch) {
      await syncFeaturesToBase(project, { except: task.feature_id ?? undefined });
      // Unattended work publishes on the same rule as a hand-clicked ship —
      // otherwise an autopilot run's commits sit local while everything else
      // about the flow looks finished.
      await publishProjectBranch(project);
    }
  }
  trace("autopilot", `MERGED task=${task.id} into ${base} in ${secs(t0)}`);
  note(task, `✓ Autopilot merged this into ${base}.`);
  publishGlobal(task.id, { type: "task_updated" });
}

/**
 * A member's merge is out of retries. Hand it to a fresh resolver task instead
 * of dead-ending the feature.
 *
 * The old behaviour terminal-blocked here, and a terminal block is invisible to
 * both halves of the scheduler — so one unresolvable merge stopped everything
 * downstream until a human intervened. Observed twice in a single run, same six
 * files, both tasks eventually marked done by hand.
 *
 * The member is parked TRANSIENTLY rather than blocked outright: when the
 * resolver lands, the member's commits are already on the base, so its next
 * merge attempt is a no-op that closes it out with no human in the loop. The
 * backoff is long because the thing it is waiting for is another task's whole
 * lifecycle — a short one would just re-gate (and re-review) into the same
 * conflict every few minutes.
 */
function handOffConflict(
  project: Project,
  feature: Feature,
  task: Task,
  base: string,
  conflicts: string[],
  what: string
): void {
  const detail = `${what} conflicts in ${conflicts.length} file(s), and the agent could not resolve it`;
  // A resolver that conflicts must not file a resolver for itself, and a task
  // with no branch of its own has nothing for a resolver to merge.
  if (isResolutionTask(task.title) || !task.work_branch) {
    block(task, `${detail}. This one needs you.`);
    return;
  }
  const { task: resolver, existing } = fileLandResolutionTask(project, feature, task, base, conflicts);
  trace(
    "autopilot",
    `CONFLICT-HANDOFF task=${task.id} → resolver=${resolver.id} "${resolver.title}"${existing ? " (already filed)" : ""}`
  );
  if (!existing) publishGlobal(resolver.id, { type: "task_updated" });
  block(
    task,
    `${detail}.\n\nAutopilot filed "${resolver.title}" to land this work from the other side — ` +
      `it merges \`${task.work_branch}\` into \`${base}\` in its own worktree, and once it lands this task ` +
      `closes itself out. Answering here takes it back by hand instead.`,
    { retryInMs: CONFLICT_HANDOFF_RETRY_MS }
  );
}

/** Every member landed → push the integration branch and open the PR (gate 2). */
async function maybeOpenPr(project: Project, feature: Feature): Promise<void> {
  if (!feature.branch || feature.pr_url) return;
  const members = featureMembers(feature.id);
  if (!members.length) return;
  const outstanding = members.filter(
    (t) => !t.suggested && t.status !== "done" && t.status !== "cancelled"
  );
  if (outstanding.length) return;

  // Every member passed its own gate in its own worktree. That says nothing
  // about the branch they were all merged into, and a green-in-isolation set
  // CAN assemble into a red branch with no git conflict to warn anyone. Prove
  // the integration branch runs before handing it over as finished work.
  const gate = await runFeatureGate(project, feature);
  if (!gate.ok) {
    const last = members[members.length - 1];
    if (last) block(last, featureGateFailure(feature, project, gate));
    return;
  }

  const res = await createBranchPr({
    cwd: project.repo_path,
    branch: feature.branch,
    baseBranch: project.branch,
    title: feature.name,
    body: buildFeaturePrBody({
      context: feature.context,
      description: feature.description,
      outcomes: members
        .filter((t) => t.status === "done")
        .map((t) => ({ title: t.title, outcome: t.outcome })),
      featureId: feature.id,
    }),
  });

  if (res.ok && res.url) {
    updateFeature(feature.id, { pr_url: res.url });
    return;
  }
  // The work is safe on the integration branch either way, but a silent failure
  // here would leave the feature looking finished and going nowhere. Surface it
  // on the last member so it reaches the "needs you" pill rather than a log.
  const last = members[members.length - 1];
  if (last) block(last, `Every task landed, but opening the feature PR failed: ${res.error ?? "unknown error"}`);
}

// ---------- small helpers ----------

/** Send text into a task as an ordinary turn — the same path a typed message
 *  takes, so there is no second launch implementation to keep in step. */
async function sendTurn(project: Project, task: Task, text: string): Promise<void> {
  const fresh = getTask(task.id);
  if (!fresh || fresh.running || hasTurn(fresh.id)) return;
  try {
    await startResumeTurn(fresh, project, text);
  } catch (e) {
    block(task, `Autopilot could not start the follow-up turn: ${(e as Error).message}`);
  }
}

/** A quiet system line in the transcript: what autopilot did, in the user's view. */
function note(task: Task, text: string): void {
  const m = addMessage(task.id, task.generation, "system", text);
  publish(task.id, { type: "notice", content: text, msgId: m.id, generation: task.generation });
}

/**
 * Stop working this task and put it in front of the user.
 *
 * Uses the durable-notice pattern of lib/promptLimits.ts / lib/authFailure.ts —
 * a persisted transcript line plus awaiting_input — so an escalation lights up
 * the existing "N need you" pill and project badges with no new notification
 * surface to build. Cleared by any human message into the task (see the messages
 * route): answering it IS how you resume it.
 */
function block(task: Task, reason: string, opts: { retryInMs?: number } = {}): void {
  // Idempotent. A task already escalated for this exact reason gains nothing from
  // being escalated again — it just gets a duplicate transcript line — and since
  // the publish below is a scheduling signal, re-blocking would re-dirty the
  // project on every pass. maybeOpenPr re-escalates a failing feature gate on
  // each pass, which is precisely that loop.
  if (getTask(task.id)?.blocked_reason === reason) return;
  // A transient park still raises the flag — the queue IS stopped right now,
  // and saying so is honest — but it also carries its own way back, so the
  // recovery doesn't depend on the user seeing it. If the retry fails the task
  // simply re-parks, still visible; there is no silent loop to get lost in.
  console.warn(
    `[autopilot] blocked task ${task.id}${opts.retryInMs ? ` (retrying in ${Math.round(opts.retryInMs / 60000)}m)` : ""}: ${reason.split("\n")[0]}`
  );
  updateTask(task.id, {
    blocked_reason: reason,
    awaiting_input: 1,
    running: 0,
    gate_retry_at: opts.retryInMs ? Date.now() + opts.retryInMs : 0,
  });
  note(task, `⏸ Autopilot stopped here.\n\n${reason}`);
  publishGlobal(task.id, { type: "task_updated" });
}

/** The slow safety net: resume any project whose queue was mid-flight at restart. */
export async function sweepAutopilot(): Promise<void> {
  if (!resolveFeatures().autopilot) return;
  ensureAutopilot();
  for (const p of listProjects()) await sweep(p.id).catch(() => {});
}
