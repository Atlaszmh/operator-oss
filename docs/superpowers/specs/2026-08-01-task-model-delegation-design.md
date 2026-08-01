# Task Model Delegation — Design

**Date:** 2026-08-01
**Status:** Draft — awaiting spec review

## Problem

A planning turn can produce a roadmap but cannot say what should run it.

Per-task model selection already exists end to end: `tasks.model`,
`tasks.reasoning` and `tasks.permission_mode` are real columns, `updateTask`
persists them (`lib/store.ts:338-341`), the Claude driver forwards the model to
the Agent SDK (`lib/agents/claude/driver.ts:165`) and reads the reasoning and
permission defaults (`lib/agents/claude/driver.ts:143-144`), and the session
toolbar renders a grouped picker driven by the agent's capability descriptor
(`app/orchestrator/SessionView.tsx:311-331`).

The `suggest_task` MCP tool — the only way an agent creates work — takes
`title`, `description`, `priority` and `blocked_by` and nothing else
(`lib/agentToolDefs.mjs:16-32`). So when a capable model is asked to break down
a project, every task it proposes is created with `model = NULL` and
`reasoning = NULL`, meaning "inherit the driver default". A twenty-task roadmap
lands as twenty tasks that will all run on the same model regardless of whether
the work is a rename or a rearchitecture.

The cost of that is asymmetric in both directions. Routine work billed at the
top tier is waste; hard work run on a cheap tier is a failed session that gets
re-run, which is worse. The planner is the actor best placed to know which is
which — it just produced the breakdown — and it currently has no way to say so.

Correcting it by hand is worse than it looks. A suggested task card opens
`EditTaskModal` (`app/orchestrator/TaskBoard.tsx:255`), which edits title,
description, priority and dependencies only. The model picker lives in
`SessionView`, which is reachable only *after* the task has started — so the
cheapest available correction still spends the turn it was meant to avoid.

## Goals

- A planning agent assigns a model and a reasoning preset per task it suggests.
- It is told which models exist for the agent that will run the task, and given
  concrete guidance on matching work to tier.
- Its choices are visible in the tray before anything runs, and overridable
  there.
- Manual task creation gets the same two controls.
- A bad value from the model never breaks task creation.

## Non-goals

Explicitly out of scope, and not to be added speculatively:

- **Per-task agent routing.** Letting the planner choose Codex vs Claude is a
  different decision from choosing a model — it depends on which logins are
  connected at run time, which the planner cannot see. Suggested tasks continue
  to inherit `projects.default_agent`.
- **An app-level `default_model` setting.** `default_reasoning` and
  `default_permission_mode` have agent-scoped app defaults; model does not, and
  this feature does not add one.
- **A user-editable rubric.** The routing guidance is a prompt string. Promoting
  it to a stored, editable setting is a small change later if the built-in text
  proves wrong; building the settings surface now is speculative.
- **Budget caps or spend policy.** No per-project token ceiling, no enforcement.
- **Changing `SessionView`'s picker.** It works; it is untouched.

## Design

### 1. Storage — no migration

`tasks.model` and `tasks.reasoning` already exist. `createTask()`
(`lib/store.ts:294-318`) never writes either, so every task is born `NULL`. It
gains two optional inputs and includes both columns in its `INSERT`. That is the
entire persistence change.

### 2. A `tier` field on the capability descriptor

`AgentModelOption` (`lib/agents/types.ts:19-25`) gains:

```ts
tier?: "light" | "standard" | "heavy" | "max";
```

Assignments:

| Agent | light | standard | heavy | max |
|-|-|-|-|-|
| Claude | `haiku` | `sonnet` | `opus` | `fable` |
| Codex | `gpt-5.1-codex-mini` | — | `gpt-5.1-codex-max` | — |

Every other entry — the `[1m]` variants, the pinned versions, the legacy
options — carries no tier.

**Untiered means picker-only.** A human can still select "Opus 4.6 · legacy"
from the session toolbar; the planner is never shown it. This keeps the
delegation menu short and stops a planner routing work to a pinned old model
because the label sounded capable.

The field exists so the routing rubric can be *generated* from the descriptor
rather than written as prose naming specific models. Prose would be smaller
today and silently wrong the first time the model list moves — a rubric telling
a planner to use "Haiku" after `haiku` left the picker is worse than no rubric,
because it fails without any error.

`sub` cannot serve this purpose. Those strings are picker subtitles written for
a human scanning a dropdown ("efficient for routine tasks"); they carry no
ordering a generator can read.

**Known ceiling, to be marked with a `ponytail:` comment:** one model per tier.
A planner facing heavy work across a very large codebase will pick `fable`
(tier `max`, 1M window) rather than `opus[1m]`, because the 1M variants are
untiered. Upgrade path if that proves costly: make the tier map to a list and
let the rubric mention window size as a secondary axis.

A test asserts no agent declares the same tier twice — the generator assumes at
most one model per tier and would otherwise emit a silently ambiguous menu.

### 3. The prompt — `buildProjectContext()`

`buildProjectContext(project, task)` (`lib/agents/shared.ts:16`) is
agent-agnostic and already the place that teaches an agent about `suggest_task`
(lines 34-42). Both drivers call it — Claude appends it to the system prompt
(`lib/agents/claude/driver.ts:169`), Codex prepends it to the first user message
(`lib/agents/codex/driver.ts:138`). Extending it here reaches both agents with
no duplication into the stdio bridge.

**Whose capabilities.** The menu is built from
`getCapabilities(project.default_agent)`, not from `task.agent`. A suggested
task's agent comes from `createTask`'s fallback to the project default
(`lib/store.ts:306`), because `suggest_task` does not set one. Reading the
planner's own agent would offer Claude model values to a plan whose tasks will
run on Codex.

**Import safety.** `lib/agents/capabilities.ts` is the SDK-free capability
lookup that exists precisely so low-level modules can read this data without
dragging an agent SDK into their import graph — the async-external hazard
documented at the top of that file. `shared.ts` imports `getCapabilities` from
there, never from `registry.ts`. `tests/importGraph.test.ts` pins the rule.

**What it emits.** Appended to the existing `suggest_task` paragraph:

1. The tiered menu — one line per tiered model: value, label, `sub`.
2. The routing rubric, one line per tier:
   - **light** — mechanical, well-scoped edits; docs; renames; test scaffolding;
     anything with a clear recipe
   - **standard** — ordinary feature work in a familiar codebase;
     straightforward bugfixes
   - **heavy** — multi-file refactors, tricky debugging, design and architecture
     calls, security-sensitive work
   - **max** — whole-codebase reasoning, novel architecture, or work needing the
     largest context window
3. Reasoning guidance from `capabilities.reasoningOptions`: name the available
   presets, leave it off for mechanical work, reserve the highest setting for
   the single hardest task in the plan.
4. That omitting either parameter inherits the project default.

**Sparse tiers.** Codex declares only two. The generator walks the four tiers in
fixed order and attaches each tier's guidance to the lowest *present* tier at or
above it; guidance for tiers above the highest present one attaches to that
highest tier. Codex therefore renders two lines — `mini` carrying the light
blurb, `max` carrying standard + heavy + max. No empty line is ever emitted, and
no category of work is left without a destination.

**Reasoning intensity is array order.** `reasoningOptions` runs lowest to
highest in both descriptors today (`off → think → think_hard → ultrathink`).
The generator relies on that. It is load-bearing and gets a comment saying so,
since nothing in the type enforces it.

An agent whose descriptor lists no tiered models gets no menu, no rubric and no
mention of the parameters — the paragraph degrades to what it says today.

### 4. Tool definition

`SUGGEST_TASK.params` (`lib/agentToolDefs.mjs:23-29`) gains `model` and
`reasoning`. Both are documented as "one of the values listed in your project
context; omit to inherit the project default".

Both consumers declare them as `z.string().optional()`:

- `lib/agents/claude/driver.ts:63-68` — the in-process SDK MCP server
- `scripts/orch-mcp.mjs:78-86` — the portable stdio bridge

Not `z.enum`. The bridge is plain Node ESM and cannot import the TypeScript
capability descriptors, so an enum would exist on one side only and the two
schemas would drift — the exact failure `lib/agentToolDefs.mjs` was created to
prevent. Nothing tests that parity today; the shared param strings are what
enforce it, and both call sites `.describe()` from the same constant. The menu
lives in the prompt; value enforcement lives in one server-side place, below.

### 5. Validation

`createSuggestedTask()` (`lib/agentTools.ts:47-68`) is the single implementation
both the in-process server and the bridge's HTTP endpoint route through, so it
is the only place validation is needed.

`SuggestTaskInput` gains optional `model` and `reasoning`. Each is checked
against `getCapabilities(project.default_agent)` — `models[].value` and
`reasoningOptions[].value` respectively. A recognised value is passed to
`createTask`; anything else becomes `NULL`.

Validation accepts **any** value in the descriptor, including untiered ones. The
tier list governs what is *offered*; it does not restrict what is *accepted*. A
planner that names a valid pinned model is not wrong, and rejecting it would
make the accepted set differ from the picker's for no benefit.

An unrecognised value appends a note to the text returned to the agent:

> Suggested task "…" added to the project tray (id: …). (model "gpt-5" isn't
> available for this project's agent — using the default.)

Degrading with a note rather than throwing matches the `blocked_by` handling
directly above it, and the note is what lets the planner correct itself on its
next call instead of repeating the mistake twenty times.

The input is model-generated text crossing into a database write, so it is a
trust boundary: no value reaches `createTask` without matching a known
descriptor entry.

### 6. UI

**Route.** `POST /api/tasks` (`app/api/tasks/route.ts:18-27`) passes `model` and
`reasoning` through to `createTask` under the same `typeof === "string"` guard
it already uses for `agent`. `PATCH /api/tasks/[id]` already whitelists both
(`app/api/tasks/[id]/route.ts:32`) — no change.

**Shared control.** One field component in `app/orchestrator/modals.tsx`: a
native `<select>` with `<optgroup>` sections from `AgentModelOption.group`, fed
by the existing `modelOptions(caps)` / `reasoningOptions(caps)` helpers
(`app/orchestrator/types.ts:216-217`), which already prepend the "Default"
entry mapping to `null`.

A native select rather than the `Popover` pattern `SessionView` uses: the Claude
list runs to fourteen options, and a native control gets keyboard navigation,
type-ahead, scroll containment and screen-reader semantics without any of them
being written or maintained. The modals already sit closer to plain form
controls than the session toolbar does.

**`NewTaskModal`** — both fields below the existing `AgentPicker`, driven by
`capsFor(agents, agent)` so they re-render when the agent selection changes.
`onCreate` gains `model` and `reasoning`.

**`EditTaskModal`** — the same two fields. It currently receives no `agents`
prop and gains one, to resolve capabilities from `task.agent`. `onSave`'s patch
gains both fields. This is the path that matters: it is what a suggested-task
card opens, so it is where a planner's choice is reviewed and overridden before
the task ever runs.

**Task card** — the model's label beside the existing `AgentBadge`, shown only
when `task.model` is set. `TaskRow` already carries `model`
(`app/orchestrator/types.ts:36`). Without this the assignment is invisible until
something is opened, and an invisible assignment is one no one will trust.

## Testing

- **`tests/agentTools.test.ts`** — the behavioural test. A `suggest_task` with a
  valid model and reasoning persists both to the task row. One with an
  unrecognised model persists `NULL` *and* returns text containing the
  correction note. An untiered-but-valid model is accepted.
- **`tests/orchMcp.test.ts`** — the bridge's own test spawns the real
  `scripts/orch-mcp.mjs` against a fake app server and asserts what it forwards.
  Extended so a `suggest_task` call carrying model and reasoning is shown
  arriving at the internal endpoint. This is the only test that can catch the
  bridge half being forgotten.
- **`app/api/internal/agent-tools/suggest-task/route.ts`** — covered by the
  existing endpoint tests in `agentTools.test.ts`, extended for the two fields.
- **Tier uniqueness** — one assertion that no agent's `models` declares a tier
  more than once.
- **Prompt generation** — that a two-tier agent (Codex) emits guidance for all
  four categories across its two lines, and that an agent with no tiered models
  emits no menu at all.

`tests/importGraph.test.ts` already fails if `shared.ts` reaches a driver module
or an agent SDK; the new import is deliberately routed through
`lib/agents/capabilities.ts` to satisfy it.

## Files touched

| File | Change |
|-|-|
| `lib/agents/types.ts` | `tier?` on `AgentModelOption` |
| `lib/agents/claude/capabilities.ts` | tier on four entries |
| `lib/agents/codex/capabilities.ts` | tier on two entries |
| `lib/agents/shared.ts` | menu + rubric generation in `buildProjectContext` |
| `lib/agentToolDefs.mjs` | two new `SUGGEST_TASK.params` |
| `lib/agents/claude/driver.ts` | two schema fields, pass through |
| `scripts/orch-mcp.mjs` | two schema fields, pass through |
| `lib/agentTools.ts` | validate, note, pass to `createTask` |
| `lib/store.ts` | `createTask` accepts + inserts both columns |
| `app/api/tasks/route.ts` | pass both through |
| `app/orchestrator/modals.tsx` | shared select; both modals |
| `app/orchestrator/TaskBoard.tsx` | model label on the card |
| `app/Orchestrator.tsx` | `agents` prop into `EditTaskModal` |
| `tests/agentTools.test.ts`, `tests/orchMcp.test.ts` | coverage |
| `README.md` | `suggest_task`'s parameters and the delegation behaviour |
| `CLAUDE.md` | the `tier` convention in the agent-driver seam section |

Per the repo's conventions, behaviour changes keep `README.md` current, and the
`tier` field is a new rule for anyone adding a third agent — a driver that ships
untiered models silently opts out of delegation, which is worth one line in the
seam description. No new env var, so `.env.example` is unaffected.

No database migration. No new dependency. No change to the runner, the SSE
contract, or the driver interface.
