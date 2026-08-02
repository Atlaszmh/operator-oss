# Autopilot — Design

**Date:** 2026-08-02
**Status:** Approved by the user (design presented and confirmed 2026-08-02).

## Problem

Every unit of progress in the orchestrator terminates in a human click.

`suggest_task` files work into the tray with `suggested = 1`
(`lib/agentTools.ts:158`), where it sits until someone starts it. Starting it is
a `POST /api/tasks/[id]/messages` the user types. The turn runs, and
`lib/runner.ts` settles the row with `awaiting_input = 1` — the agent stops and
waits. Merging is a button (`app/api/tasks/[id]/merge/route.ts`), opening a PR is
a button (`app/api/tasks/[id]/pr/route.ts`), and `status = 'done'` is a manual
edit; the merge route says so explicitly ("The user owns the 'done' status").

The result is that the operator's throughput is bounded by the operator's
attention, not by the agents. Running twelve sessions in parallel is worth little
when each one needs a human to start it, a human to read it, and a human to land
it — and most of those reads confirm what the transcript already said.

Two costs follow.

**The dependency graph is inert.** `task_dependencies` exists, `setTaskDeps()`
guards it against cycles, and `suggest_task({blocked_by})` lets a planner express
ordering across a whole breakdown (`lib/store.ts:380`, `lib/agentToolDefs.mjs`).
Nothing reads it. A planner can perfectly describe "task C after A and B" and the
graph is rendered as a badge — the user still has to remember the order and start
each task by hand.

**The feature layer stops one step short.** A feature can own an integration
branch that its members base off and merge into, and `taskBaseBranch()`
(`lib/store.ts`) is the single resolution point every merge/PR/worktree path
routes through. So the *git* shape of "a feature is a unit of review" is already
built and correct. What's missing is anything that walks that shape without being
driven.

The gap is not infrastructure. It is a controller and a definition of "done that
doesn't need me".

## Goals

- A user approves a plan once, and the tasks in it run to completion without
  further intervention.
- Tasks run in parallel where their dependencies allow, bounded by a configured
  cap.
- A task merges into its feature's integration branch only after passing a gate
  that does not consist of a human reading the transcript.
- Work that autopilot cannot resolve escalates visibly and does not stall its
  siblings.
- A completed feature arrives as a pushed branch and an open PR against the
  project's base branch — the user's second and final gate.
- Autopilot is opt-in per feature. `autopilot = 0` is today's behaviour, byte for
  byte.

## Non-goals

Explicitly out of scope, and not to be added speculatively:

- **Autonomy through to `main`.** The PR is the terminal state. Autopilot never
  merges to the project branch. That is the user's gate and the reason the design
  is shaped this way.
- **Project-level autopilot.** The switch is on a feature, because what gets
  approved is a plan, not a mode. There is no "run everything in this project".
- **Push notifications / email / Slack.** The GitHub PR notification and the
  existing "N need you" pill are the notification surface. See §6.
- **A budget or cost cap.** `task_usage` already records per-turn spend. Measure
  before building a mechanism.
- **A per-feature concurrency override.** One env-driven default (§3). Add the
  override when a real feature wants a different number.
- **Re-running gates when the integration branch moves under a task.** CI on the
  feature PR is the arbiter of the combined state. See §4.
- **Feature-level conflict resolution.** Unchanged from the feature-layer design:
  reported, not resolved in-app.
- **A new planning UI.** Planning happens in an ordinary task with an ordinary
  transcript. See §1.

## 1. The loop

The user is the PM at exactly two points.

```
  User ──▶ chat in a PLANNING TASK ──▶ agent writes features.context (the spec)
                                    └─▶ agent files suggest_task calls w/ blocked_by
  User ──▶ [Approve plan] ──────────────────────────────────────── GATE 1
              │  un-suggests every task in the feature
              │  cuts the integration branch (createFeatureBranch)
              └─ features.autopilot = 1
                     │
                     ▼
         ┌───▶ scheduler: pick ready tasks (deps satisfied), up to cap
         │          └─▶ startTurn() with the task description
         │                  └─▶ turn ends
         │                        └─▶ GATE: test_command in worktree + reviewer agent
         │                              ├─ pass ─▶ mergeTask() into features.branch
         │                              ├─ fail ─▶ feedback as next turn (≤ N tries)
         │                              └─ exhausted / asked / conflicted ─▶ escalate
         └──────── loop until no ready tasks ────────┘
                     │
                     ▼
         all members done ──▶ push features.branch + open PR to the project branch
                     │
  User ◀──────────────┘  review + merge on GitHub ──────────────── GATE 2
                     │
                     ▼
         sweep sees PR merged ──▶ mark feature merged, reap worktrees
```

**Planning is not a new surface.** A planning task is an ordinary task whose
prompt asks the agent to produce a spec and a breakdown. It has a transcript, a
session lineage, `/clear`, and everything else a task has, because it *is* one.
The agent calls `suggest_feature` (writing the agreed spec into
`features.context`) and `suggest_task({feature, blocked_by})` — both tools exist
and need no change. Approve plan is the only new affordance in the flow.

This is deliberate: a dedicated feature-planning panel would duplicate the
transcript, the turn lifecycle, and the streaming stack to buy a graph view.

## 2. Schema

Four columns on two existing tables. No new tables.

| Column | Purpose |
|-|-|
| `features.autopilot INTEGER NOT NULL DEFAULT 0` | the switch; `0` = today's behaviour |
| `features.pr_url TEXT NOT NULL DEFAULT ''` | mirrors `tasks.pr_url`; set = awaiting the user's review |
| `tasks.gate_attempts INTEGER NOT NULL DEFAULT 0` | retry budget consumed; reset by any human message |
| `tasks.blocked_reason TEXT NOT NULL DEFAULT ''` | why autopilot stopped touching this task (`''` = not blocked) |

Added via the existing `add(...)` migration helper in `lib/db.ts`, and to the
`CREATE TABLE` bodies, following the pattern already used for `dev_command` etc.

**No `features.autopilot_state` column.** The feature-layer design rejected a
stored `status` because it would need writing from every path that touches a
member task and would drift the first time one was missed. The same argument
applies exactly here, and the state is derivable in `listFeatures()`:

| Derived state | Condition |
|-|-|
| off | `autopilot = 0` |
| in review | `pr_url != ''` |
| needs you | any member has `blocked_reason != ''` |
| running | otherwise, while unfinished non-suggested members remain |
| done | otherwise |

`FeatureWithCounts` gains `blocked_count` alongside the existing `awaiting_count`
so the card can render the state without a second query.

## 3. New modules

### `lib/autopilot.ts` — the controller

One exported entry point, `sweep(projectId)`, doing one idempotent pass:

1. For each autopilot feature in the project, find members whose last turn has
   settled (`running = 0`, not `blocked_reason`, `status != 'done'`) and gate them
   (§4).
2. Start ready tasks — `suggested = 0`, `status` not terminal, `started = 0`, and
   every id in `getTaskDeps()` resolved to a member with `status = 'done'` — up to
   the concurrency cap, counting currently-running members.
3. When no unfinished members remain and `pr_url` is empty, open the feature PR
   (§5).
4. For features with an open PR, poll `gh pr view --json state`; a merged PR sets
   `features.merged_at` and releases the members' worktrees.

**Driven by events, not a timer.** `subscribeGlobal()` (`lib/events.ts`) already
broadcasts `turn_end` for every task in every project; autopilot subscribes and
sweeps the affected project. A turn ending is precisely when there is new work to
do, so a polling loop would be pure waste.

A slow safety sweep rides the existing `lib/recap.ts` cadence so a server restart
mid-queue resumes rather than stranding the feature. `sweep()` is idempotent, so
the two triggers overlapping is harmless.

Sweeps mark the instance busy via `lib/idle.ts` — the sleep daemon must not stop
the container between two tasks of a running queue.

Concurrency comes from `lib/config.ts` as `ORCH_AUTOPILOT_CONCURRENCY`
(default 2), documented in `.env.example` per the env-driven convention.

### `lib/gates.ts` — the done gate

`runGate(task, project, feature)` → `{ ok: boolean; feedback: string }`.

Two halves, both required to pass:

**Tests.** Spawn `project.test_command` with `cwd: task.worktree_path`. This
cannot reuse `lib/services.ts`, which spawns with `cwd: project.repo_path`
(`lib/services.ts:466`) — the whole point is to test the task's isolated tree, not
the shared one. A one-shot child process with a timeout, not a supervised
service. An empty `test_command` skips this half and says so in `feedback`; it is
never a silent pass.

**Review.** A one-shot through `lib/agents/oneshots.ts` on the **utility agent** —
project-scoped routing, deliberately not the task's own agent, so a model is not
grading its own homework. It receives the task's diff, the task description, and
`features.context`, and returns a verdict plus notes.

On failure the combined `feedback` is sent as an ordinary message into the task
(the `startTurn()` path, like every other turn) and `gate_attempts` increments.
Past the cap, the task escalates (§6).

`buildReviewPrompt()` and the verdict parser live together in
`lib/agents/shared.ts`, next to `buildConflictPrompt()` and for the same stated
reason: a prompt and the thing that reads its output must not drift apart.

**Shadow mode.** `ORCH_AUTOPILOT_SHADOW=1` (a `lib/features.ts` flag) runs the
full gate, records and renders the verdict, and stops short of merging — the user
still clicks. This exists so the reviewer's judgment can be calibrated against
real work before it is trusted to land code unattended, and is the recommended
setting for the first weeks.

### `lib/github.ts` — a feature-level PR

`createTaskPr` is generalized to `createBranchPr({ cwd, branch, baseBranch, title,
body })`, with `createTaskPr` reduced to a thin caller passing the worktree. A
feature has no worktree, so its `cwd` is `project.repo_path`.

This is the same split `landBranch()` already made out of `mergeTask()` — factor
out the part that does not need a worktree so the feature-level caller can reach
it — and it is worth naming the precedent so the shape stays consistent.

### Routes

| Route | Does |
|-|-|
| `POST /api/features/[id]/approve-plan` | un-suggest every member, `createFeatureBranch()` if `branch` is empty, set `autopilot = 1`, sweep |
| `POST /api/features/[id]/pr` | push + open the PR (also callable by hand) |
| `PATCH /api/features/[id]` | gains `autopilot` — the pause/resume switch |

Pausing sets `autopilot = 0`. Running turns are left alone; the scheduler simply
stops starting new ones and stops gating. Stopping in-flight work is what the
existing Stop button is for.

## 4. Merge and conflicts

Branching needs no change. `ensureWorktree()` already forks task branches from
`taskBaseBranch(task, project)`, which resolves to the feature's integration
branch when it has one.

Per task, on a passing gate: `fastForwardWorktree()`, then `mergeTask()`.
`mergeTask()` is already wrapped in `withRepoLock` (`lib/git.ts:796`), which
serializes per-repo main-tree mutations — **the merge queue already exists**, and
parallel autopilot merges into one integration branch are already safe.

If the integration branch advanced while a gate was running, the merge proceeds
without re-gating. This is a deliberate corner: re-running a full test suite on
every base movement would serialize the fan-out that the parallelism exists to
buy, and CI on the feature PR is the arbiter of the combined state — which is
what CI is for. The cost is that a semantic conflict between two independently
green tasks surfaces at the PR rather than at the merge. It should carry a
`ponytail:` comment naming that ceiling.

A merge conflict is handed to the task's own agent as an ordinary message built
by `buildConflictPrompt()` — the exact path the client takes today
(`lib/agents/shared.ts`), moved server-side. The task re-gates afterwards. A
conflict the agent fails to resolve escalates like any other exhausted gate.

## 5. Handoff

When the last member lands, autopilot pushes `features.branch` and opens a PR
against `projects.branch` via `createBranchPr`. The body is assembled from
`features.context` (the approved spec) and every member's `tasks.outcome` line —
which is exactly what the feature-layer design already established as a feature's
business summary, so there is nothing new to generate or keep in sync.

`features.pr_url` is set; the feature reads "in review". The user reviews and
merges on GitHub, where CI, diff tooling, and review comments already live. The
sweep's `gh pr view` poll notices the merge, sets `merged_at`, and reaps the
member worktrees through the existing maintenance path.

If `gh` is not authenticated, the push/PR step escalates with the actionable
message `lib/github.ts` already produces, rather than failing silently. The work
is safe on the integration branch either way.

## 6. Escalation

Anything autopilot cannot resolve sets `tasks.blocked_reason`, appends a durable
notice to the persisted transcript, and leaves `awaiting_input = 1`.

This is the pattern `lib/promptLimits.ts` and `lib/authFailure.ts` already use —
a durable transcript line the UI matches to render a recovery affordance — chosen
here so escalation lights up the existing "N need you" pill and project badges
with no new notification surface.

Triggers: gate failed past the attempt cap · the agent raised `ask_user` · a
merge conflict the agent could not resolve · an auth or usage-limit failure · the
PR step failed.

The scheduler skips blocked tasks and keeps working other ready ones. Dependents
of a blocked task simply never become ready — no special casing, the dep check
already produces that behaviour.

**Any human message into a blocked task clears `blocked_reason` and resets
`gate_attempts`.** Answering it is how you unblock it; there is no separate
"resume" affordance to forget about.

## 7. Testing

`tests/autopilot.test.ts`, mocking the driver at the SDK boundary and running
through the real runner, per `tests/agentDriver.test.ts`; git fixtures from
`tests/helpers.ts`. New env read at import time goes into `tests/setup.ts`.

Pinned behaviours:

- A task with an unsatisfied dep never starts.
- Concurrency never exceeds the cap, counting already-running members.
- A failing gate feeds back and retries, then blocks at the cap.
- A blocked task does not stall its independent siblings.
- The last member landing opens the feature PR exactly once.
- A human message clears `blocked_reason` and `gate_attempts`.
- `autopilot = 0` leaves every existing path unchanged (the byte-for-byte claim).

## 8. Risks

**The reviewer agent is load-bearing.** Every claim this design makes about
reduced management rests on the reviewer catching what the user would have
caught. A reviewer that rubber-stamps automates a rubber stamp. Shadow mode (§3)
exists to measure that before trusting it, and is the recommended initial
setting.

**The attempt cap is a guess.** Too low reproduces babysitting under another
name; too high lets a confused agent loop through quota. Ships as an env default
(`ORCH_AUTOPILOT_ATTEMPTS`, default 2) precisely because the right number is
empirical.

**Cost.** Parallel members plus a reviewer one-shot per gate attempt consume
tokens materially faster than the current one-task-at-a-time flow. `task_usage`
records it per turn; watch it before deciding whether a budget mechanism is
warranted.
