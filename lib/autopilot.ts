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

import { syncFeaturesToBase, syncTasksToBase, catchUpWorktree } from "./featureSync";
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
import { runGate, gateIsAdvisory, runFeatureGate, featureGateFailure, runTestsIn } from "./gates";
import { mergeTask, fastForwardWorktree, worktreeSyncStatus } from "./git";
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
    // Any turn can be the one that files new work, not just a member's: a
    // planning task is normally ungrouped, and its suggest_task calls are
    // exactly what an armed feature is waiting for. Filtering on feature_id
    // meant a plan landed in the tray and nothing came to collect it. A sweep
    // for a project with no armed feature is one indexed query and a return.
    if (task) void sweep(task.project_id).catch(() => {});
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

  // The gate reached no verdict about the work — the reviewer itself couldn't
  // run (usage limit, no connected utility agent, a turn that died). Leave the
  // task exactly as it is: no attempt charged, no turn sent, still settled, so
  // the next sweep gates it again once the reviewer is back. Charging an outage
  // to the task blocked finished work behind it AND sent the agent an error
  // string as if it were review feedback to act on.
  // ponytail: no user-visible signal while the reviewer is down — the task just
  // sits in "needs you" as it already did. Surface a per-task inconclusive count
  // if outages ever get long enough to be confusing.
  if (verdict.inconclusive) {
    console.warn(`[autopilot] gate inconclusive for task ${task.id}, will retry: ${verdict.feedback}`);
    return;
  }

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
      block(task, `Catching up to ${base} conflicts in ${preSync.conflicts.length} file(s), and the agent could not resolve it.`);
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
  if (!result.alreadyMerged) {
    // Sibling tasks first: they share this base and are the ones racing it.
    // Catching them up HERE is what stops the next one hitting a conflict the
    // size of the whole race rather than the size of this merge.
    await syncTasksToBase(project, base, { except: task.id });
    // Then, if what landed was the PROJECT branch, every live feature follows —
    // unattended work is exactly where silent divergence is worst, because
    // nobody is watching the branches while autopilot walks the plan.
    if (result.targetBranch === project.branch)
      await syncFeaturesToBase(project, { except: task.feature_id ?? undefined });
  }
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
