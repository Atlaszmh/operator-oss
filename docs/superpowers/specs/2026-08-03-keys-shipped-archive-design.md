# Keys, shipped state, and the archived section

Three small additions to the feature layer, none of which change how anything
runs — they change what you can *see* and what you can *name*.

1. **Keys.** Every task and feature gets a JIRA-style `TME-42` identifier, so
   there is something to say out loud instead of "the archived-section one".
2. **Shipped state.** A feature's tile says whether it has actually landed.
   Today `features.merged_at` is set on ship and then rendered nowhere except
   halfway down the feature page.
3. **An archived section.** `features.archived` already exists, and archiving is
   currently a one-way trapdoor: the flag hides the feature from every list, and
   no list shows archived features, so nothing can ever be restored.

## 1. Keys

### Shape

`TME-42` — a per-project prefix and a per-project number, one counter shared by
tasks and features, exactly as JIRA numbers issues within a project.

### Storage

| Column | Why |
|-|-|
| `projects.key` | The prefix. Derived on create, editable, unique across projects (case-insensitive). |
| `projects.key_seq` | The counter. Monotonic — never decremented, so deleting `TME-42` cannot hand 42 to the next thing created. Mirrors `nextServicePort()`'s "never reuse a freed slot" rule, for the same reason: an identifier that gets recycled is worse than no identifier. |
| `tasks.seq`, `features.seq` | The number half. Written once at insert, never updated. |

**The display key is derived, never stored.** `listTasks`/`listFeatures` are
already project-scoped, so each reads the project's key once and computes
`` `${key}-${seq}` `` in the same `.map()` that already attaches usage and
dependency data. One helper, `taskKey(projectKey, seq)` in `lib/keys.ts`, is the
only place the format lives.

Storing the rendered string instead would mean a second source of truth that
drifts the first time a project key is edited, plus a backfill over every task
and feature to repair it. Deriving makes a key edit instant and total — the same
argument `listFeatures` already makes for not storing a feature's status.

### Prefix derivation

`deriveProjectKey(name)` in `lib/keys.ts`:

- Two or more words with letters → their initials, capped at 5 (`Two Minute
  Empire` → `TME`).
- One word → its first four letters (`Alloy` → `ALLO`).
- Nothing usable → `PRJ`.

Uniqueness is a numeric suffix (`TME`, `TME2`, `TME3`), resolved by
`uniqueProjectKey(name, taken)` so both create and migrate share one rule.

### Editing

A **Key** field in the project context modal, next to the name. Validation is
shared by the client (to disable Save) and `PATCH /api/projects/[id]` (to reject
a direct call): `^[A-Z][A-Z0-9]{1,9}$` after uppercasing, and unique. A clash
returns 409 with the conflicting project named, rather than silently renaming.

Editing a key re-keys every task and feature in that project at once. That is
the intended behaviour and matches JIRA's project-key rename; it is worth saying
out loud in the field's hint, because a key someone has already pasted into a
commit message will stop resolving.

### Backfill

One guarded migration, following the `migrated_building_fold` precedent
(a `settings` row, so it runs once and never again):

1. Every project without a key gets a derived, deduped one.
2. Per project, its features and tasks are numbered together in `created_at`
   order, so the numbering reflects the order things were actually filed rather
   than table order.
3. `projects.key_seq` is set to the last number handed out.

### Where a key shows

Task card, board card, feature group header, feature page, session header, and
the ⌘K palette. Both search boxes and the palette's fuzzy rank include the key
in their match text, so typing `42` or `tme-42` finds the thing.

`findFeature()` gains key resolution (id → key → name), because that resolver is
already project-scoped and is how an agent refers to a feature it has not seen
an id for.

**Not in scope:** resolving a key in `blocked_by`. That resolver takes a
session-scoped title→id map with no project in hand, so accepting keys means
threading a project id through both tool mount paths — agent-facing plumbing for
a feature whose point is human sharing. Ids and titles still work there.

## 2. Shipped state

`featureState(f)` in `app/orchestrator/format.ts`, beside the other derived
predicates (`isAwaiting`). Pure, first match wins:

| State | Rule | Tile |
|-|-|-|
| `shipped` | `merged_at > 0`, or — with no integration branch — every member done **and** merged | ✓ SHIPPED, green |
| `in_review` | `pr_url` set | ◷ IN REVIEW, amber |
| `done` | every member done, not all merged | DONE, dim |
| `building` | anything running, done, awaiting or blocked | no pill |
| `planned` | otherwise | no pill |

`shipped` outranks `in_review`: a set `merged_at` means that PR is behind you.

`building` and `planned` get no pill on purpose — the ratio and progress bar
already say it, and a pill on every tile is a pill that means nothing.

The second `shipped` clause exists because an integration branch is opt-in, so
most features never get a `merged_at` at all; without it the badge would almost
never appear. It requires two new counts in the `listFeatures` rollup subquery,
`merged_count` and `running_count` — both derived alongside the counts already
there, so there is still no write path that can drift.

A feature with tasks all done but *not* all merged reads `done`, not `shipped`.
That is what keeps the claim honest in a project with no repo configured, where
nothing can ever merge.

A shipped tile also desaturates and turns its progress hairline green, so
"finished" reads at a glance and not only from the pill. The hairline keeps
showing the real ratio rather than being forced to 100%: a feature can have a
landed branch and an unfinished task, and a full bar would say otherwise.

The integration-branch chip is dropped from a shipped tile — the branch has
landed, so it is the least interesting thing on the row, and that row is the
tightest one in the column.

## 3. The archived section

- **`inFeature()` counts archived features.** Today archiving a feature dumps
  its tasks loose into the flat status groups — the opposite of what the code
  comment above `byStatus` says the grouping is for ("a shipped feature
  collapses to one line instead of spraying rows into two distant global
  buckets"). Archived features keep their tasks filed under them.
- **A collapsed `Archived` section** at the bottom of the tasks column, reusing
  `FeatureGroup` and the existing `useCollapsed`, default collapsed, persisted
  per project. This is what makes Restore reachable.
- **Ship auto-archives.** `POST /api/features/[id]/ship` sets `archived: 1` in
  the same `updateFeature` call as `merged_at`, and only when commits actually
  landed — a re-ship of an already-merged branch changes nothing, matching the
  existing `merged_at` rule directly above it.
- **Finished features sink and fold.** A feature whose derived state is `shipped`
  or `done` sorts below the unfinished ones and defaults to collapsed, with an
  Archive button on its own header. One click, no page visit.

### Deliberately not built

**Auto-archiving when the last task flips to done.** It would need a write from
every path that touches `tasks.status` — `updateTask`, `setTaskStatus`, the
board's drag, the runner's turn-end settle — and would go wrong the first time
one was missed. That is the exact failure `listFeatures` derives its counts to
avoid. The derived `done` state plus a one-click Archive covers it with nothing
to keep in sync.

**Autopilot features never self-archive.** They terminate at `in_review`, and
the PR is merged on GitHub where the app never hears about it. Archiving stays
the user's click.

**The board is untouched.** Its columns are status, so an archived feature's
tasks keep appearing there; the feature filter already excludes archived
features. Making the board feature-aware is a separate change.

## Known interaction, not introduced here

On a project with no recap and no history, `useRecaps`' landing effect
re-selects the first task the moment `selTask` goes null, which undoes opening a
feature page (and the project-banner recap button) on desktop. It predates this
work — the effect and `selectFeature` are both untouched — and only bites on a
brand-new project, since any project with a recap takes the other branch. Worth
fixing, separately.

## Tests

- `tests/keys.test.ts` — derivation, dedupe, the shared counter across both
  tables, no reuse after a delete, and the backfill's `created_at` ordering.
- `tests/featureState.test.ts` — one case per row of the table above, including
  the no-branch/all-merged clause and the no-repo `done` case.
