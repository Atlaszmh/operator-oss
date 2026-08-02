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
} from "./store";
import { startInitialTurn, startResumeTurn } from "./runner";
import { runGate, gateIsAdvisory } from "./gates";
import { mergeTask, fastForwardWorktree } from "./git";
import { createBranchPr, buildFeaturePrBody } from "./github";
import { buildConflictPrompt } from "./agents/shared";
import { subscribeGlobal, publishGlobal, publish } from "./events";
import { hasTurn } from "./abort";
import { workStarted, workEnded } from "./idle";
import { resolveFeatures } from "./features";
import { AUTOPILOT_CONCURRENCY, AUTOPILOT_ATTEMPTS } from "./config";
import type { Feature, Project, Task } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __orchAutopilot: { armed: boolean; running: Set<string>; again: Set<string> } | undefined;
}

// HMR-surviving controller state, same pattern as lib/events.ts / lib/abort.ts.
function state() {
  if (!global.__orchAutopilot) global.__orchAutopilot = { armed: false, running: new Set(), again: new Set() };
  return global.__orchAutopilot;
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
    if ((ev as { type?: string }).type !== "turn_end") return;
    const task = getTask(taskId);
    // Ungrouped tasks are not autopilot's business — an approved plan is always
    // a feature, so a task with no feature_id can't be part of one.
    if (task?.feature_id) void sweep(task.project_id).catch(() => {});
  });
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
  const st = state();
  if (st.running.has(projectId)) {
    st.again.add(projectId);
    return;
  }
  st.running.add(projectId);
  // Count the queue as live work so the idle daemon can't stop the container
  // between two tasks of a running plan.
  workStarted();
  try {
    do {
      st.again.delete(projectId);
      await sweepOnce(projectId);
    } while (st.again.has(projectId));
  } finally {
    st.running.delete(projectId);
    st.again.delete(projectId);
    workEnded();
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
      console.error(`[autopilot] feature ${feature.id} failed its pass:`, e);
    }
  }
}

async function driveFeature(project: Project, feature: Feature): Promise<void> {
  // 1. Gate everything that finished a turn and is now sitting on the user.
  for (const t of featureMembers(feature.id)) {
    if (!isSettledForGating(t)) continue;
    await gateAndLand(project, feature, t);
  }

  // 2. Start ready members, up to the cap. Re-read: step 1 moved rows.
  const live = featureMembers(feature.id).filter((t) => t.running || hasTurn(t.id)).length;
  let slots = Math.max(0, AUTOPILOT_CONCURRENCY - live);
  for (const t of readyMembers(feature.id)) {
    if (slots <= 0) break;
    // A started task belongs to the gating path above, not to launching.
    if (t.started) continue;
    const res = await startInitialTurn(t, project);
    if (!res.ok && res.status !== 409) {
      block(t, `Autopilot could not start this task: ${res.error}`);
      continue;
    }
    slots--;
  }

  // 3. Everything landed → hand the feature back to the user as a PR.
  await maybeOpenPr(project, feature);
}

/** A task the gate should look at: started, handed back to the user, not
 *  running, not already escalated, not finished. */
function isSettledForGating(t: Task): boolean {
  return (
    !!t.started &&
    !t.suggested &&
    !t.running &&
    !hasTurn(t.id) &&
    !t.blocked_reason &&
    !!t.awaiting_input &&
    t.status !== "done" &&
    t.status !== "cancelled" &&
    t.status !== "on_hold"
  );
}

/**
 * Gate one finished task and, if it passes, land it. A failure is a follow-up
 * turn rather than an error: the task keeps its session and is told what to fix,
 * which is what a human reviewer would have done with the same finding.
 */
async function gateAndLand(project: Project, feature: Feature, task: Task): Promise<void> {
  const verdict = await runGate(task, project, feature);

  if (!verdict.ok) {
    const attempts = task.gate_attempts + 1;
    if (attempts > AUTOPILOT_ATTEMPTS) {
      block(task, `The gate failed ${AUTOPILOT_ATTEMPTS} times, so autopilot stopped retrying.\n\n${verdict.feedback}`);
      return;
    }
    updateTask(task.id, { gate_attempts: attempts });
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
  const base = taskBaseBranch(task, project);

  if (!task.worktree_path || !task.work_branch) {
    // Nothing isolated to merge — the task ran directly in the repo (non-git or
    // empty repo), so its work is already on the base branch. Just close it out.
    updateTask(task.id, { status: "done", awaiting_input: 0, gate_attempts: 0 });
    return;
  }

  // Catch up to the branch's current tip first, so the merge is a fast-forward
  // wherever it can be. If the base moves again during this, the merge still
  // proceeds — CI on the feature PR is the arbiter of the COMBINED state, which
  // is what CI is for. Re-gating on every base movement would serialize exactly
  // the fan-out the concurrency cap exists to allow.
  // ponytail: no re-gate after a base move; a semantic conflict between two
  // independently-green tasks surfaces at the PR, not at the merge.
  await fastForwardWorktree(task.worktree_path, base);

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
        block(task, `Merging into ${base} conflicts in ${result.conflicts.length} file(s), and the agent could not resolve it.`);
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
  note(task, `✓ Autopilot merged this into ${base}.`);
  publishGlobal(task.id, { type: "task_updated" });
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
function block(task: Task, reason: string): void {
  updateTask(task.id, { blocked_reason: reason, awaiting_input: 1, running: 0 });
  note(task, `⏸ Autopilot stopped here.\n\n${reason}`);
  publishGlobal(task.id, { type: "task_updated" });
}

/** The slow safety net: resume any project whose queue was mid-flight at restart. */
export async function sweepAutopilot(): Promise<void> {
  if (!resolveFeatures().autopilot) return;
  ensureAutopilot();
  for (const p of listProjects()) await sweep(p.id).catch(() => {});
}
