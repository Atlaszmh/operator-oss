# Feature Layer — Design

**Date:** 2026-08-01
**Status:** Draft — sections 1–2 approved by the user; sections 3–5 decided under
delegated authority ("move forward with the whole planning and implementation")
and flagged below for review.

## Problem

The hierarchy is two levels deep: a project owns tasks, and nothing sits
between them.

That works while a project is a handful of tasks. It stops working the moment a
project carries thirty, because `tasks` is a flat list whose only organizing
axes are status and manual position. `listTasks()` orders by
`suggested, position, created_at` (`lib/store.ts:220`) and the list view buckets
the result into six status groups (`app/orchestrator/TasksColumn.tsx:109-115`).
A task called "add the Stripe webhook handler" and a task called "fix the typo
in the footer" render as peers, sorted by whichever happens to be in progress.

Two concrete costs follow.

**Context is re-pasted per task.** `buildProjectContext()`
(`lib/agents/shared.ts:93`) prepends the project's single `context` field to
every session. There is one such field per project, so shared knowledge that
applies to *some* tasks — the billing rework's data model, the constraints on
the auth migration — either bloats project context for every unrelated task, or
gets retyped into each task's description, or is simply omitted and rediscovered
by each session from scratch.

**A planned breakdown arrives as confetti.** `suggest_task` is the only way an
agent creates work (`lib/agentToolDefs.mjs:16`). Ask a capable model to break
down a feature and it calls the tool once per task, correctly. Twenty tasks land
in the suggested tray as twenty unrelated cards. `blocked_by` records ordering
between them, but nothing records that they are *one piece of work* — so the
grouping the planner had in its head is discarded at the tool boundary.

The middle layer that fixes both is the one every issue tracker already has:
JIRA's Epic between Initiative and Story, Linear's Project between Roadmap and
Issue, GitHub's Milestone over Issues.

## Goals

- An optional Feature groups tasks within a project. Tasks not in one behave
  exactly as they do today.
- A Feature carries context that is prepended to its member tasks' sessions,
  after project context.
- A Feature may own an integration branch: its tasks base off it and merge into
  it, and the Feature lands on the project branch as one unit.
- An agent can declare a Feature and file the tasks it plans into it.
- Progress across a Feature is visible without opening it.

## Non-goals

Explicitly out of scope, and not to be added speculatively:

- **Nested features.** No sub-features, no feature-of-features. One optional
  level, not an arbitrary tree. If a project needs two levels of grouping above
  tasks it needs to be two projects.
- **Cross-project features.** A feature belongs to exactly one project, enforced
  by `UNIQUE(project_id, name)` and a cascade on `project_id`.
- **A feature-level status field.** Progress is derived from member tasks. See
  §1 for why a stored status is rejected.
- **Feature-level conflict resolution UI.** If merging the project branch into a
  feature branch conflicts, we report it and stop. The per-task conflict flow
  (`prepareWorktreeMerge` → AI resolution turn → `completeWorktreeMerge`) is not
  duplicated at the feature level. See §3.4.
- **Board swimlanes.** Board view gets a feature filter and feature chips on
  cards, not per-feature rows. Restructuring `TaskBoard.tsx`'s drag-and-drop into
  a two-dimensional grid is a larger change than the grouping it would buy.
- **Drag-a-task-into-a-feature.** Assignment is a dropdown in the task modals.
- **Feature-level usage rollup.** `task_usage` is keyed by task and project;
  summing it per feature is a later query, not a schema change, and Insights
  does not grow a feature axis here.

## Design

### 1. Storage

One new table and one nullable column.

```sql
CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  context     TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',
  branch      TEXT NOT NULL DEFAULT '',
  base_sha    TEXT NOT NULL DEFAULT '',
  merged_at   INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id);
```

`tasks` gains `feature_id TEXT REFERENCES features(id) ON DELETE SET NULL`,
added through the existing `migrate()` path in `lib/db.ts:319-357` alongside the
other post-release task columns, plus `idx_tasks_feature`.

The `features` table itself is created in the `CREATE TABLE IF NOT EXISTS` block
and needs no `migrate()` entry — the same reasoning the `task_dependencies`
comment records (`lib/db.ts:157-158`): older databases pick it up on next boot.

Four decisions worth defending:

**No `status` column.** Progress is `done / total` over member tasks, computed
in the same query that lists features. A stored status is a second source of
truth that drifts the moment a task is re-statused from the board, and keeping
it correct means writing to `features` from every path that writes `tasks.status`
— `updateTask`, `setTaskStatus`, `moveTask`, the runner's turn-end settle. The
derived count has no such coupling.

**`archived`, not `deleted`.** Mirrors `projects.deprecated` (`lib/db.ts:44`)
exactly, including the semantics: hidden from the working set, restorable, never
built on. Reusing the pattern means the UI affordance is already understood.

**`ON DELETE SET NULL`, not `CASCADE`.** This is a deliberate exception to the
"delete is hard delete throughout" convention (CLAUDE.md). Everywhere else that
convention deletes a thing and the things that *are* it — a project's tasks, a
task's messages. A feature is not what its tasks are; it is a label over them.
Cascading would mean that removing an organizational mistake destroys the work
filed under it, including merged branches and worktrees. Deleting a feature
un-groups its tasks back to "No feature" and they are otherwise untouched.

> **Flagged for review.** If you would rather this match the convention, the
> change is `ON DELETE SET NULL` → `ON DELETE CASCADE` plus a "delete its N
> tasks too" checkbox in the confirm dialog. One line plus a checkbox.

**`UNIQUE(project_id, name)`.** Features are addressable by name within a
project. This is what lets `suggest_task({feature: "Billing v2"})` resolve
without the agent having to thread an id — the same affordance `blocked_by`
already offers for task titles (`lib/agentTools.ts:29-31`).

#### 1.1 Progress rollup

`listFeatures(projectId)` returns each feature plus four counts, computed in one
grouped query:

| Field | Definition |
|-|-|
| `total` | member tasks that are not suggested and not cancelled |
| `done` | member tasks with `status = 'done'` |
| `suggested_count` | member tasks with `suggested = 1` |
| `awaiting_count` | member tasks with `awaiting_input = 1` |

Suggested tasks are excluded from `total` because they are proposals, not
committed work — a freshly planned feature would otherwise read "0/12" for work
nobody has accepted. They are surfaced separately as "+12 suggested" on the
feature header, which is the honest reading.

`awaiting_count` mirrors the project-level count already on the project list
(`lib/store.ts:13`) so a feature header can carry the same "needs you" accent
the project sidebar does.

### 2. Prompt layering

`buildProjectContext(project, task)` gains a feature block between project
context and the task framing:

```
You are working inside the project "Operator".

What we're building (project context):
<project.context>

This task is part of the feature "Billing v2".        <-- new
Feature context:
<feature.context>

Git branch: orch/feat/billing-v2
---
The current task is: "add the Stripe webhook handler"
```

No signature change. The function already reaches into the database itself
(`listSummaries(task.id)` at `lib/agents/shared.ts:94`), so it resolves the
feature from `task.feature_id` the same way. Both drivers
(`lib/agents/claude/driver.ts:177`, `lib/agents/codex/driver.ts:138`) call it
unchanged.

The `Git branch:` line reports the task's *effective* base — `feature.branch`
when the feature has one, else `project.branch` — via the same
`taskBaseBranch()` helper §3 introduces. Today it reports `project.branch`
unconditionally, which would be actively misleading for a task working on a
feature branch.

Feature context is emitted only when non-empty, and only the feature's own
`context` field is emitted — not its description, which is a UI label. This
matters because the block lands in **every turn of every member task**: a
feature with six tasks and a 2,000-token context pays that on every turn of all
six. The UI notes this next to the editor. It is the same economics as project
context, one level down.

### 3. Git — the opt-in integration branch

The design premise is that this is mostly a change to *what one helper returns*,
not new git machinery. That premise holds: `mergeTask`, `worktreeSyncStatus`,
`fastForwardWorktree`, `prepareWorktreeMerge`, `completeWorktreeMerge` and PR
creation already accept `baseBranch` as a parameter. Ten call sites pass
`project.branch` today:

```
app/api/tasks/[id]/merge/route.ts:32          app/api/tasks/[id]/sync/route.ts:26,28,53,77
app/api/tasks/[id]/merge/prepare/route.ts:34,46   app/api/tasks/[id]/pr/route.ts:38
app/api/tasks/[id]/merge/complete/route.ts:31     lib/runner.ts:110
```

#### 3.1 One helper, all callers

```ts
// lib/store.ts
export function taskBaseBranch(task: Task, project: Project): string {
  if (!task.feature_id) return project.branch;
  const f = getFeature(task.feature_id);
  return f?.branch || project.branch;
}
```

Every one of the ten sites becomes `baseBranch: taskBaseBranch(task, project)`.
This is the root-cause shape: a task's base branch is derived in exactly one
place, so a path that forgets about features cannot exist.

#### 3.2 The one site that is not already parameterised

`ensureWorktree(repoPath, taskId)` (`lib/git.ts:103`) does **not** take a base.
It reads `rev-parse HEAD` for `baseSha` (`lib/git.ts:128`) and runs
`git worktree add -b <branch> <path>` with no start-point (`lib/git.ts:135`),
so a new task branches off whatever the repo's HEAD happens to be.

It gains an optional third parameter:

```ts
ensureWorktree(repoPath, taskId, baseBranch?: string)
```

When supplied *and the branch exists*, it is used as both the `rev-parse` target
and the `worktree add` start-point. When absent or unknown, behaviour is exactly
as today (HEAD). The existence check is what keeps greenfield and commitless
repos — which `ensureWorktreeLocked` explicitly supports (`lib/git.ts:117-123`)
— working unchanged.

This also closes a latent inconsistency that predates features: today a task's
`base_sha` comes from HEAD while its merge target is `project.branch`, so a repo
sitting on a different branch produces a task whose diff base and merge target
disagree. Passing the resolved base branch fixes that for every task, feature or
not.

#### 3.3 Creating and shipping a feature branch

**Create.** Setting a feature's branch creates it from the project branch and
records the fork point:

```
git branch <name> <project.branch>     # in repo_path
features.branch  = <name>
features.base_sha = rev-parse <name>
```

Default name is `orch/feat/<slugified name>`, editable. Attaching to an existing
branch is allowed (the create is skipped if it already exists).

**Guard.** Setting or changing `branch` is refused when any member task already
has a worktree (`worktree_path != ''`). Those worktrees were cut from a
different base; silently re-pointing them would make their diffs and merges
wrong in a way that is invisible until a merge produces garbage. The API returns
a 409 naming the blocking tasks, and the UI disables the control with that
reason. Clearing `branch` back to `''` is subject to the same guard.

**Ship.** Merging a feature branch into the project branch is the same operation
`mergeTask` performs after its commit step — and `mergeTask` already handles the
case where the target is not the checked-out branch, via
`mergeIntoTargetWorktree` (`lib/git.ts:736-737`). So `mergeTask` is split:

- `landBranch({repoPath, workBranch, baseBranch, message})` — everything from
  the stranded-merge recovery (`lib/git.ts:720`) onward: recover, resolve target,
  check ahead-count, dispatch to in-place or throwaway-worktree merge.
- `mergeTask(...)` — `commitWorktree()` then `landBranch()`. Identical behaviour;
  its signature and result shape do not change.
- `mergeFeature({repoPath, featureBranch, baseBranch, message})` — `landBranch()`
  directly. A feature branch has no worktree, so there is nothing to commit
  first.

One implementation of "land a branch", two callers. Shipping sets
`features.merged_at`.

**Ship guard.** Refused while any member task is unmerged and not
done/cancelled, with the count named. This is advisory — the user can mark tasks
done or cancel them — not a lock.

#### 3.4 Feature sync

A long-lived feature branch falls behind the project branch. The read side needs
no worktree at all: `worktreeSyncStatus` uses the worktree only for its
`isDirty` check (`lib/git.ts:1019`); `behind`, `ahead` and
`predictMergeConflicts` are pure branch arithmetic over `repoPath`.

So `worktreeSyncStatus`'s `worktreePath` becomes optional: when absent,
`isDirty` is `false` and everything else is computed as it is today. The
existing early return (`lib/git.ts:1010`) currently bails on an empty
`worktreePath`; it narrows to bailing only on an empty `workBranch`. Every
current caller passes a real worktree path and is unaffected.

The write side reuses the throwaway-worktree merge: merging `project.branch`
into `features.branch` is `landBranch({workBranch: project.branch, baseBranch:
feature.branch})` — the same helper, arguments swapped.

**If that merge conflicts, we report the conflicting paths and stop.** There is
no worktree to resolve them in and no session to hand them to. This is marked in
the code with a `ponytail:` comment naming the ceiling and the upgrade path
(cut a temporary worktree on the feature branch and run the existing
`prepareWorktreeMerge` → AI-resolution → `completeWorktreeMerge` flow against
it). Feature-level conflicts should be rare: every task merged into the feature
branch cleanly, so the only source of divergence is the project branch moving.

> **Flagged for review.** This is the sharpest corner cut in the design. The
> failure mode is "Sync says conflicted, resolve it in your own checkout" rather
> than an in-app resolution. If long-running features are a real pattern for you
> rather than a hypothetical, this is the first thing to upgrade.

### 4. UI

#### 4.1 The tasks column

Feature groups render **above** the existing status groups, and the status
groups are unchanged — they simply contain only the tasks with no feature. A
project with no features renders exactly as it does today, byte for byte.

```
Needs your input          1        <-- pinned, spans all features (unchanged)
─────────────────────────────
▾ Billing v2       3/7  ●2  ▸      <-- feature groups, position order
    [~] add the Stripe webhook
    [ ] webhook retry policy
▸ Auth refresh     1/4      ▸
─────────────────────────────
In progress               2        <-- status groups: featureless tasks only
Not started               4
Done                      6
Cancelled                 1
```

"Needs your input" stays pinned at the top spanning every feature. It is how the
app answers "what is blocking me" and scattering it across collapsible feature
groups would break that. A feature whose tasks are waiting shows a count dot on
its header instead.

Within a feature, tasks sort by the existing status order then `position`.
Done and cancelled members sort to the bottom of their feature rather than into
the global Done/Cancelled groups — a shipped feature collapses to one line
rather than spraying rows into two distant buckets.

The feature header is a `<div>` containing two buttons — chevron toggles
collapse (persisted per feature in `localStorage`, matching `useCollapsed` at
`TasksColumn.tsx:72`), name opens the feature page. Nested buttons are invalid
HTML, hence the split; the existing `tgh-btn` single-button header is kept for
the status groups, which have nothing to open.

The suggested tray at the bottom (`TasksColumn.tsx:173`) sub-groups by feature
when its members have one, so a planned breakdown arrives as one labelled block
instead of twenty loose cards.

#### 4.2 The feature page

The session column's switch is `task ? SessionView : project ? ProjectLanding :
empty` (`app/Orchestrator.tsx:208-247`). A feature page slots in as a third
case, mirroring `ProjectLanding`:

```
task ? SessionView : selFeature ? FeatureLanding : project ? ProjectLanding : empty
```

`selFeature` is new state in `useOrchestrator`, cleared whenever `selTask` is
set — the same mutual exclusion `onShowRecap={() => o.setSelTask(null)}`
(`app/Orchestrator.tsx:199`) already uses for the project landing. It is *not*
persisted to the URL: project and task selection are deep-linkable because they
survive reloads meaningfully; a transient feature pane is not worth the
persistence surface.

The page carries: name and description, the context editor (with the
per-turn-cost note from §2), the progress rollup, the member task list, and the
branch controls — set/clear branch, sync status with a Sync button, and Ship.
With no branch set, the branch section is a single "Use an integration branch"
affordance and nothing else renders.

#### 4.3 Everywhere else

- **Task cards** get a feature chip next to the existing agent and model badges
  (`TasksColumn.tsx:29-33`), in both list and board views, so a feature is
  visible even when grouping is not active.
- **Board view** gets a feature filter in its header. Not swimlanes — see
  Non-goals.
- **New/Edit task modals** get a Feature dropdown (options: the project's
  non-archived features, plus "No feature").
- **Project banner** gets a "+ Feature" button next to "+ Task"
  (`TasksColumn.tsx:128`).
- **`TaskRow`** (`app/orchestrator/types.ts:27`) gains `feature_id`; a new
  `FeatureRow` carries the table's columns plus the four rollup counts.

### 5. Agent tools

#### 5.1 `suggest_feature`

A new definition in `lib/agentToolDefs.mjs`, mounted the same two ways every
existing tool is: the Claude driver's in-process SDK server
(`lib/agents/claude/driver.ts:43`) and the stdio bridge
(`scripts/orch-mcp.mjs:60`) → `app/api/internal/agent-tools/suggest-feature`.

```
suggest_feature({ name, description, context })
```

Upsert by `(project_id, name)`: an unknown name creates, a known one updates
description and context. Upsert rather than create-or-fail because a planning
turn that re-runs, or a second turn extending the same feature, should not error
or duplicate.

The behaviour lives in `lib/agentTools.ts` as `createSuggestedFeature(project,
input)`, alongside `createSuggestedTask`, so both mount paths share one
implementation — the split the file's header comment already establishes
(`lib/agentTools.ts:1-10`).

Features created by an agent are **real immediately**, not staged in a tray.
The tray exists for tasks because a task represents work that will consume
tokens; a feature is a label. Its tasks still land in the tray exactly as they
do today, now grouped under the feature name.

`suggest_feature` never sets `branch`. Creating git branches is not something a
planning turn should do as a side effect; it is a deliberate act with a guard
(§3.3) and it stays in the user's hands.

#### 5.2 `suggest_task({ feature })`

One new parameter, resolved against the task's project: an id passes through, a
name matches `UNIQUE(project_id, name)`, an unknown name **creates a bare
feature** with that name and an empty context.

Auto-create rather than reject because the alternative is a planner that calls
`suggest_task` twenty times, gets twenty errors, and files nothing. The tool's
returned text names what happened ("filed under a new feature 'Billing v2' —
it has no context yet"), which is the same feedback channel `validateRun()`
already uses to correct a planner mid-roadmap (`lib/agentTools.ts:44-57`).

A feature reference that names a *different project's* feature is dropped to
`null` with a note, matching how `setTaskDeps` drops foreign task ids
(`lib/store.ts:255-258`).

#### 5.3 Prompt guidance

The `suggest_task` guidance block in `buildProjectContext`
(`lib/agents/shared.ts:111-120`) gains a third bullet: when a breakdown is one
coherent piece of work, call `suggest_feature` first with the shared spec, then
pass its name to each `suggest_task`. The existing project features are listed
by name so a planner extends one instead of inventing a near-duplicate.

## Delivery

Three shipments. Each leaves the app in a working, useful state.

**Phase 1 — grouping, context, rollup.** Schema, store queries, REST surface,
`buildProjectContext` layering, tasks-column grouping, feature page, create and
assign. Independently useful: manual features with shared context.

**Phase 2 — agent planning.** `suggest_feature`, `suggest_task({feature})`, both
mount paths, prompt guidance.

**Phase 3 — integration branches.** `taskBaseBranch()`, `ensureWorktree` base
parameter, `landBranch` extraction, `mergeFeature`, optional-worktree sync,
branch UI, guards.

Phase 3 is roughly 60% of the work and carries all of the risk, which is why it
lands against a UI that already exists and can be observed.

## Testing

Tests are vitest, serial, hermetic against tmp dirs (`tests/setup.ts`), with git
fixtures from `tests/helpers.ts`. New file `tests/features.test.ts` plus
additions to the existing merge and driver tests.

**Storage and rollup**
- A feature deleted with member tasks leaves those tasks present with
  `feature_id = NULL`. This is the convention exception from §1 and is the test
  that stops a future refactor from "fixing" it into a cascade.
- Deleting the *project* still cascades features away.
- `UNIQUE(project_id, name)` permits the same feature name in two projects.
- Rollup counts: suggested members excluded from `total`, cancelled excluded
  from both `total` and `done`, `awaiting_count` tracks `awaiting_input`.

**Prompt layering**
- Feature context appears in `buildProjectContext` output for a member task and
  is absent for a featureless one.
- The `Git branch:` line reports the feature branch when set, the project branch
  otherwise.

**Git**
- `taskBaseBranch` resolves feature branch → project branch → project branch
  when the feature's branch is empty.
- `ensureWorktree` with a base branch cuts the worktree from that branch's tip,
  not HEAD — asserted by putting the repo's HEAD on a *different* branch first,
  which is the case that silently produces a wrong diff base today.
- `ensureWorktree` with an unknown base branch falls back to HEAD and still
  works on a greenfield repo.
- A task in a branch-owning feature merges into the feature branch and leaves
  the project branch untouched.
- `mergeFeature` lands the feature branch on the project branch; the project
  branch then contains commits from every member task.
- The branch guard rejects setting `branch` when a member task holds a worktree.
- `worktreeSyncStatus` with no worktree path returns real `behind`/`ahead`
  counts and `isDirty: false`.

**Agent tools**
- `suggest_feature` upserts by name rather than duplicating.
- `suggest_task` with an unknown feature name creates it and says so in the
  returned text.
- `suggest_task` with another project's feature id files the task with
  `feature_id = NULL` and says so.

**Regression**
- A project with no features produces a task list identical to the pre-change
  grouping, and `buildProjectContext` output is unchanged for a featureless
  task.
