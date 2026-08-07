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

`Feature` type (`lib/types.ts`) gains `depends_on?: string[]`.

## Store (`lib/store.ts`)

Mirror the task-dep functions:

- `setFeatureDeps(featureId, depIds)` — dedupe, drop self and cross-project
  ids, DFS cycle guard, throws `"dependency cycle"` (same contract as
  `setTaskDeps`).
- `getFeatureDeps(featureId)`.
- `listFeatures()` bulk-joins `depends_on` the same way `listTasks()` does.
- `featureDepsSatisfied(featureId)` — true when every dep row has a non-null
  `merged_at`. Archived-without-merge does **not** satisfy: an abandoned
  predecessor stalls the chain rather than silently starting work on a base
  that never got the prerequisite. Manual approve-plan remains the escape
  hatch.

## Approval + kickoff

- Extract the body of `app/api/features/[id]/approve-plan/route.ts` into an
  idempotent `approvePlan(feature, project)` helper (new `lib/approvePlan.ts`
  or colocated in `lib/autopilot.ts` — implementer's choice). Idempotent =
  skips work if the feature is already armed (`autopilot === 1`) or already
  has a branch. The route becomes a thin wrapper.
- `kickoffDependents(featureId)`: query reverse edges; for each dependent
  that is not archived, not already armed, and has `featureDepsSatisfied()`,
  call `approvePlan()`. Failures are logged/streamed per-dependent and never
  fail the ship itself.
- Call site: `app/api/features/[id]/ship/route.ts`, immediately after
  `updateFeature(id, {merged_at, archived: 1})`. Ship is the only writer of
  `merged_at`, so a direct call suffices — no new event type, no queue.
  Stream an NDJSON progress line per kicked-off dependent.
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
  listing the project's other features, same pattern as task `DepPicker`.
  Writes via `PATCH /api/features/[id]` (new `depends_on` field →
  `setFeatureDeps`).
- Feature card: "after: <name>" badge when deps exist and are unshipped
  (pattern: `blockerTitles()` in `app/orchestrator/format.ts`). No new
  `featureState()` value — a dormant chained feature reads as "planned".

## Edge cases

- **Cycles**: DFS guard rejects at write time (both agent and UI paths).
- **Deleted predecessor**: cascade removes the edge; the dependent never
  auto-fires (there is no ship event to trigger it) and stays suggested until
  manually approved. Accepted.
- **Manual early approve**: approve-plan on a dependent whose deps aren't
  shipped just works — manual action overrides the chain; the edge becomes
  informational.
- **Diamond deps** (C after A and B): C fires on whichever ship completes
  last, since kickoff requires *all* deps satisfied. Free via
  `featureDepsSatisfied`.
- **Shadow mode / `ORCH_FEATURE_AUTOPILOT` off**: a kicked-off feature
  behaves exactly like a manually approved one — armed, but merges still
  gated by the existing flags. Chaining adds no new bypass.

## Tests

`tests/featureDeps.test.ts`:

- `setFeatureDeps`: dedupe, self-edge dropped, cross-project dropped, cycle
  throws.
- `featureDepsSatisfied`: unshipped → false; shipped → true;
  archived-without-merge → false.
- `kickoffDependents`: arms dependent only when all deps shipped; skips
  archived and already-armed dependents; idempotent on double ship.
- Orphan: deleting predecessor leaves dependent dormant.

## Out of scope

- No feature-level event channel (bus stays task-keyed).
- No "start when tasks done" trigger mode (rejected in design).
- No UI for visualizing whole chains beyond the per-card badge.
