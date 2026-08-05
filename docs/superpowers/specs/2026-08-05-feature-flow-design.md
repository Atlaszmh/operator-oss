# Making the feature flow a well-oiled machine

The goal is that shipping a feature is a click, not an investigation. Today it
is sometimes an investigation. This is what actually went wrong, measured on the
Chute Happens repo, and what to change — ordered by leverage, not by ambition.

## What the evidence says

Nine features have run through the Chute Happens project. Every problem below is
observed, not hypothesised.

**Hub files guarantee collisions.** Across the last eight feature merges:

| File | Feature merges touching it |
|-|-|
| `shell/src/scene.ts` | 4 |
| `core/src/lib.rs` | 4 |
| `core/wasm-parity.mjs` | 4 |
| `shell/src/tools.ts` | 3 |
| `core/src/world/mod.rs` | 3 |

CH-98 vs CH-103 is the pure case: **both added a render layer to the same
`app.stage.addChild(...)` line** in `scene.ts`, and nothing else in either
feature overlapped. Every visual feature must register itself in that one call,
so every pair of concurrent visual features collides there. Structural, not luck.

**Divergence is only discovered at ship time.** CH-98 forked at `024fb46` and sat
there while CH-103 shipped 7 commits onto main. Nothing told it. By the time the
user clicked Ship, the conflict was weeks of work old.

**A feature-level conflict is a dead end in-app.** Tasks get AI conflict
resolution (`prepareWorktreeMerge` → resolve → `completeWorktreeMerge`).
Features get a 409 and a "resolve it in your own checkout" message. That is a
deliberate `ponytail:` decision in the sync route, and it is the single biggest
hole in the flow: the moment a feature conflicts, the tool stops being a tool.

**The gate is a third of the real check.** Operator runs `cd core && cargo test
&& cargo build --target wasm32 && node wasm-parity.mjs`. `shell/package.json`
already defines the real one:

```
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
  && cargo build --target wasm32-unknown-unknown --release && node wasm-parity.mjs
  && tsc --noEmit && node tools-check.mjs && node phase-check.mjs && node playtest.mjs
```

Nothing typechecks the shell before a merge. CH-41's duplicate `declare const
__BUILD__` (a TS2451) would have merged green. So would a botched `scene.ts`
merge — which is exactly the file features collide in.

**`NODE_ENV=production` is set in the container**, so a plain `npm ci` silently
skips `typescript` and `vite` (they are devDependencies). Any npm-based gate
degrades to a no-op without `--include=dev`. Observed: `npm ci` installed 12
packages and `npx tsc` refused to run.

**Archived does not mean landed.** CH-94 `Spawn Pop VFX` is archived and
unshipped with **6 unmerged commits that would conflict**. Archiving hid work
that never landed.

**Shipping does not stop a branch growing.** CH-30 `M1 Placement UI` shipped,
archived, PR merged — then gained **5 more commits**, now 74 behind main and
conflicting. Nobody will ever look at that branch again.

**Accumulation.** 28 live worktrees, 38 local branches (29 of them `orch/*`
task branches), nothing pruned. Plus duplicated commits — the same message 2–4×
on a branch — from repeated re-applies.

## The plan

### Tier 0 — settings only, no code, do first

1. **Point the gate at the project's real check.** Set the project's
   `test_command` to the full `npm run check`, and its `setup_command` to
   `cd shell && NODE_ENV=development npm ci --include=dev` so `tsc` exists in
   every worktree. This one change would have caught CH-41's duplicate declare
   and would catch any bad merge of a hub file.
   - **Measured: 104s, exit 0, on main** (2026-08-05) — comfortably inside the
     10-minute `GATE_TEST_TIMEOUT_MS`. But that is with a **warm** `core/target`.
     Every task runs in a *fresh worktree* with a cold target dir, so the first
     `cargo clippy --all-targets` + `cargo test` + release wasm build compiles
     the crate from scratch each time. CH-112 was filed as "cargo test does not
     fit the 10-minute CI budget" for exactly this reason.
   - **So do 1a first: give every worktree a shared cargo cache.** Set
     `CARGO_TARGET_DIR` to one path outside the worktrees (the persisted home
     volume). Compilation is then paid once per change rather than once per
     task, which is what makes the full check affordable as a gate at all. This
     is the cheapest item in this document and it unblocks the most valuable one.
2. **If the full check is too slow for every task, split it.** Per-task gate
   keeps the fast half; the *feature* gate (`runFeatureGate`, which already runs
   once per ship against the assembled branch) runs the full check. That is the
   right place for the expensive suite anyway — it is the last gate before code
   reaches main, and it runs once per feature rather than once per task.
3. **Prune.** 28 worktrees and 29 task branches are pure overhead. The
   maintenance route already exists.

### Tier 1 — conflict avoidance (the biggest win)

4. **Sync every active feature when any feature ships.** The moment main moves,
   every other live feature branch merges main in. Conflicts then surface within
   minutes of their cause, on a small diff, against work still fresh in a
   session's context — instead of weeks later against a 31-commit branch. The
   sync endpoint already exists; this is a call from the ship route and from
   autopilot's `sweep`.
   - This alone would have turned CH-98 from a hand-resolved merge into a
     one-line auto-merge, because at the moment CH-103 landed, `scene.ts` had
     one added layer to reconcile, not a whole feature.
   - When the auto-sync conflicts, do NOT fail silently: raise it the way
     autopilot raises a stuck task (`blocked_reason` + the "N need you" pill),
     so it lands in the one queue already watched.
5. **Make the hub files stop being hub files.** The deepest fix is in the game,
   not the tool: a layer registry where each feature appends in its own file
   instead of editing one shared `addChild` call. Same for `core/src/lib.rs`
   exports and the `wasm-parity` golden list. Worth one refactor task — it
   removes the collision class rather than managing it.
6. **Surface the collision at plan time.** When a feature is planned while
   another is active, list the hub files both are likely to touch. Cheap
   version: derive each project's hot-file list from git history and put it in
   the project context, so planners design around it.

### Tier 2 — conflict resolution in-app

7. **Give features the resolution flow tasks already have.** The upgrade path is
   already written down in the sync route's own comment: cut a temp worktree on
   the feature branch, run `prepareWorktreeMerge` → AI resolution →
   `completeWorktreeMerge` against it. Everything needed exists; it has simply
   never been wired for the feature level. After Tier 1 this is rarer, but it is
   the difference between "the tool handles it" and "the tool gives up".

### Tier 3 — never strand work

8. **Refuse to archive a feature with unmerged commits** (or warn hard). CH-94
   is the case this prevents.
9. **Notice post-ship commits.** If a shipped feature's branch moves ahead of the
   project branch again, say so. CH-30 is the case this prevents.
10. **Make shipped self-healing.** `features.merged_at` drifted from reality on
    CH-31 and CH-41 — merge on main, `merged_at` still 0, so the UI kept
    offering Ship. Reconcile it from git (branch fully reachable from the project
    branch ⇒ shipped) on the feature page and the recap sweep, rather than
    trusting a single write to have happened. Consistent with how this codebase
    derives every other feature-level fact.

## Ordering

Tier 0 is settings and can be done immediately. Tier 1.4 (sync-on-ship) is the
highest-leverage code change in the list and should come next — most of Tier 2
and 3 exist to handle failures that Tier 1.4 largely prevents. Tier 1.5 is a
game-side refactor and is the only item that removes a problem class outright.
