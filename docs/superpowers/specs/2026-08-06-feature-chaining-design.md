# Feature Chaining — Design

2026-08-06

## Problem

Multi-feature plans produce several features, but each one needs a manual
approve-plan click. There is no way to express "when feature A ships, start
feature B." Task-level `blocked_by` can cross features, but it can't keep a
feature dormant (branch uncut, tasks suggested) until its predecessor's work
is actually merged.

## Decisions (settled with user)

- **Trigger**: a dependency is satisfied when the predecessor is
  **shipped/merged** (`merged_at` set). Not "all tasks done" — the dependent's
  branch must fork a base that already contains the predecessor's work.
- **Authoring**: both the planning agent (`suggest_feature` gains `after:`)
  and the human (dep picker in the feature edit UI).
- **Kickoff semantics**: approve once, chain runs. Approving the head of a
  chain implicitly approves the whole chain; when a feature ships, each
  dependent whose deps are all shipped automatically receives the
  approve-plan treatment (branch cut, members un-suggested, autopilot armed).
- **No approval flag**: the dependency edge itself is the chain-approval
  marker. A chain edge only exists because the planner or user deliberately
  created it. Opting out = delete the edge or archive the dependent.

## Schema

New table in `lib/db.ts`, mirroring `task_dependencies` (including the inline
migration pattern):

```sql
CREATE TABLE IF NOT EXISTS feature_dependencies (
  feature_id    TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, depends_on_id)
)
```

`Feature` type (`lib/types.ts`) gains `depends_on?: string[]`. (Precedent
note: the task mirror puts `depends_on` on the store-level `TaskWithUsage`
type in `lib/store.ts`, not on `Task` in `lib/types.ts` — for features we
put it on the shared type deliberately; don't hunt for a matching precedent.)

## Store (`lib/store.ts`)

Mirror the task-dep functions:

- `setFeatureDeps(featureId, depIds)` — dedupe, drop self and cross-project
  ids, DFS cycle guard, throws `"dependency cycle"` (same contract as
  `setTaskDeps`).
- `getFeatureDeps(featureId)`.
- `listFeatures()` bulk-joins `depends_on` the same way `listTasks()` does.
- `featureDepsSatisfied(featureId)` — true when every dep row has
  `merged_at > 0` (the column is `INTEGER NOT NULL DEFAULT 0`).
  Archived-without-merge does **not** satisfy: an abandoned
  predecessor stalls the chain rather than silently starting work on a base
  that never got the prerequisite. Manual approve-plan remains the escape
  hatch.

## Approval + kickoff

- Extract the body of `app/api/features/[id]/approve-plan/route.ts` into an
  `approvePlan(feature, project)` helper (new `lib/approvePlan.ts` or
  colocated in `lib/autopilot.ts` — implementer's choice). Idempotency
  matches the current route's behavior: skip **entirely** only when already
  armed (`autopilot === 1`); when a branch already exists (e.g. cut via
  POST /branch), skip only the branch-cut and still un-suggest members and
  arm. The `ORCH_FEATURE_AUTOPILOT` flag check moves from the route into
  `approvePlan()` itself — it no-ops (with a log) when the flag is off, so
  chain kickoff can never arm features on an instance whose operator
  disabled autopilot. `approvePlan()` returns its outcome
  (`did-work | already-armed | flag-off`) so the thin route wrapper can
  keep 400-ing on flag-off while kickoff just logs and moves on.
- `kickoffDependents(featureId)`: query reverse edges; for each dependent
  that is not archived, not already armed, and has `featureDepsSatisfied()`,
  call `approvePlan()`. Failures are logged/streamed per-dependent and never
  fail the caller.
- Call sites — `merged_at` has **two** writers, both must kick off:
  1. `app/api/features/[id]/ship/route.ts`, immediately after
     `updateFeature(id, {merged_at, archived: 1})`. Stream an NDJSON
     progress line per kicked-off dependent.
  2. `reconcileFeatureBranch` (`lib/featureSync.ts`), where it heals a
     lost ship stamp by setting `merged_at` — without this, a healed
     predecessor stalls the chain silently while the UI shows every dep
     shipped.
  Direct calls at both sites — no new event type, no queue.
- Branch base: because the branch is cut at kickoff time (inside
  `approvePlan`), it forks the project base *after* the predecessor merged.
  No reliance on `syncFeaturesToBase` for chain correctness.

## Agent tool

- `suggest_feature` (`lib/agentTools.ts` `createSuggestedFeature`) gains
  optional `after: string[]` — feature names or ids, resolved with the same
  logic as `resolveFeature` (auto-create on miss, consistent with how
  `blocked_by` behaves for tasks). Calls `setFeatureDeps` after upsert.
- Wire through: `lib/agentToolDefs.mjs`, the Claude in-process MCP driver
  (`lib/agents/claude/driver.ts`), the stdio bridge
  (`scripts/orch-mcp.mjs` → `app/api/internal/agent-tools/suggest-feature`).

## UI

- Feature edit modal (`app/orchestrator/modals.tsx`): dependency picker
  listing the project's other **non-archived** features, same pattern as
  task `DepPicker`. Writes via `PATCH /api/features/[id]` (new `depends_on`
  field → `setFeatureDeps`).
- Feature card: "after: <name>" badge when deps exist and are unshipped
  (pattern: `blockerTitles()` in `app/orchestrator/format.ts`). No new
  `featureState()` value — a dormant chained feature reads as "planned".

## Edge cases

- **Cycles**: DFS guard rejects at write time (both agent and UI paths).
- **Deleted predecessor**: cascade removes the edge; if that was the sole
  dep, the dependent never auto-fires (there is no ship event to trigger it)
  and stays suggested until manually approved. Accepted. (With other deps
  remaining, it still fires when those ship — consistent with "delete the
  edge = opt out".)
- **Manual early approve**: approve-plan on a dependent whose deps aren't
  shipped just works — manual action overrides the chain; the edge becomes
  informational.
- **Diamond deps** (C after A and B): C fires on whichever ship completes
  last, since kickoff requires *all* deps satisfied. Free via
  `featureDepsSatisfied`.
- **`ORCH_FEATURE_AUTOPILOT` off**: `approvePlan()` no-ops (flag check
  lives inside the helper), so kickoff arms nothing — same as manual
  approve-plan, which 400s. Chaining adds no new bypass.
- **Shadow mode** (`autopilotShadow` on): a kicked-off feature is armed
  like a manually approved one, but merges stay gated by shadow mode
  exactly as today.
- **Deps already satisfied at edge creation** (e.g. `after:` names an
  already-shipped feature — `findFeature` matches archived features, so it
  resolves rather than auto-creates): the edge is informational and the
  dependent stays dormant until manually approved. Kickoff fires only on a
  ship/heal event. This preserves the invariant that a human approve-plan
  is always upstream of any auto-kickoff — `setFeatureDeps` never arms
  anything as a side effect.

## Tests

`tests/featureDeps.test.ts`:

- `setFeatureDeps`: dedupe, self-edge dropped, cross-project dropped, cycle
  throws.
- `featureDepsSatisfied`: unshipped → false; shipped → true;
  archived-without-merge → false.
- `approvePlan`: no-ops when `ORCH_FEATURE_AUTOPILOT` off; pre-existing
  branch skips only the cut (still un-suggests and arms); already-armed
  skips entirely.
- `kickoffDependents`: arms dependent only when all deps shipped; skips
  archived and already-armed dependents; idempotent on double ship
  (covers re-ship of a restored feature).
- Orphan: deleting predecessor leaves dependent dormant.
- Edge created after deps already shipped: dependent stays dormant.

## Out of scope

- No feature-level event channel (bus stays task-keyed).
- No "start when tasks done" trigger mode (rejected in design).
- No UI for visualizing whole chains beyond the per-card badge.
