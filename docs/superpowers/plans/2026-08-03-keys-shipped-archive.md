# Keys, Shipped State & Archived Section — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Spec: `docs/superpowers/specs/2026-08-03-keys-shipped-archive-design.md`.

**Goal:** Give every task and feature a `TME-42` key, put a truthful shipped badge on the feature tile, and make archiving a two-way door with a visible Archived section.

**Architecture:** Keys are stored as two halves (`projects.key` + `tasks.seq`/`features.seq`) and joined into a display key at read time, so editing a project key re-keys everything with no backfill. Shipped state is derived client-side from the `listFeatures` rollup, adding two counts to the existing subquery rather than a status column. The archived section reuses `FeatureGroup` and the `archived` flag that already exists.

**Tech Stack:** Next.js app router, better-sqlite3 (single connection, hand-rolled `migrate()`), React client components, vitest (serial).

**Run tests with:** `npx vitest run tests/<file>` — never `npm test` while iterating (it runs the whole serial suite, several minutes of real git subprocesses).

---

## Chunk 1: The key layer

### Task 1: Key derivation helpers

**Files:**
- Create: `lib/keys.ts`
- Test: `tests/keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { deriveProjectKey, uniqueProjectKey, normalizeKey, validateKey, displayKey } from "@/lib/keys";

describe("deriveProjectKey", () => {
  it("takes initials from a multi-word name", () => {
    expect(deriveProjectKey("Two Minute Empire")).toBe("TME");
  });
  it("caps initials at 5", () => {
    expect(deriveProjectKey("a b c d e f g")).toBe("ABCDE");
  });
  it("takes the first four letters of a single word", () => {
    expect(deriveProjectKey("Alloy")).toBe("ALLO");
  });
  it("ignores punctuation and digits when taking initials", () => {
    expect(deriveProjectKey("operator-oss")).toBe("OO");
    expect(deriveProjectKey("Project 2000")).toBe("P");
  });
  it("falls back to PRJ when there is nothing usable", () => {
    expect(deriveProjectKey("   ")).toBe("PRJ");
    expect(deriveProjectKey("2000")).toBe("PRJ");
  });
});

describe("uniqueProjectKey", () => {
  it("returns the derived key when free", () => {
    expect(uniqueProjectKey("Alloy", new Set())).toBe("ALLO");
  });
  it("appends a counter when taken, case-insensitively", () => {
    expect(uniqueProjectKey("Alloy", new Set(["allo"]))).toBe("ALLO2");
    expect(uniqueProjectKey("Alloy", new Set(["ALLO", "ALLO2"]))).toBe("ALLO3");
  });
});

describe("validateKey", () => {
  it("accepts 2-10 chars starting with a letter", () => {
    expect(validateKey("TME")).toBeNull();
    expect(validateKey("A1")).toBeNull();
  });
  it("rejects too short, leading digit, and bad characters", () => {
    expect(validateKey("T")).not.toBeNull();
    expect(validateKey("1AB")).not.toBeNull();
    expect(validateKey("TM-E")).not.toBeNull();
    expect(validateKey("ABCDEFGHIJK")).not.toBeNull();
  });
  it("normalizes before validating", () => {
    expect(normalizeKey(" tme ")).toBe("TME");
    expect(validateKey(" tme ")).toBeNull();
  });
});

describe("displayKey", () => {
  it("joins the two halves", () => {
    expect(displayKey("TME", 42)).toBe("TME-42");
  });
  it("is empty when either half is missing, so the UI renders nothing", () => {
    expect(displayKey("", 42)).toBe("");
    expect(displayKey("TME", 0)).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/keys.test.ts`
Expected: FAIL — cannot resolve `@/lib/keys`.

- [ ] **Step 3: Write `lib/keys.ts`**

Five pure functions, no DB access — that is what keeps them testable and lets
both `createProject` and `migrate()` share one rule:

```ts
// JIRA-style keys: a per-project prefix (projects.key) plus a per-project
// number (tasks.seq / features.seq, from the shared projects.key_seq counter).
// The rendered "TME-42" is derived at read time, never stored — see the spec.

/** Prefix from a project name: initials for multi-word, first four letters otherwise. */
export function deriveProjectKey(name: string): string {
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 5).map((w) => w[0]).join("").toUpperCase();
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return "PRJ";
}

/** deriveProjectKey, then a numeric suffix until it's free. `taken` may be any case. */
export function uniqueProjectKey(name: string, taken: Set<string>): string {
  const lower = new Set([...taken].map((k) => k.toLowerCase()));
  const base = deriveProjectKey(name);
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    // Keep the whole thing inside validateKey's 10-char ceiling.
    const candidate = `${base.slice(0, 10 - String(n).length)}${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

export const normalizeKey = (raw: string): string => raw.trim().toUpperCase();

/** null = valid. Returns the user-facing reason otherwise. */
export function validateKey(raw: string): string | null {
  const key = normalizeKey(raw);
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key))
    return "A key is 2–10 characters, letters and digits only, starting with a letter.";
  return null;
}

/** The rendered key. "" when either half is missing, so callers can render nothing. */
export const displayKey = (projectKey: string, seq: number): string =>
  projectKey && seq > 0 ? `${projectKey}-${seq}` : "";
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/keys.test.ts`
Expected: PASS (5 + 2 + 3 + 2 assertions' worth of cases).

- [ ] **Step 5: Commit**

```bash
git add lib/keys.ts tests/keys.test.ts
git commit -m "Add the key derivation rules"
```

### Task 2: Schema, counter, and backfill

**Files:**
- Modify: `lib/db.ts` (schema block ~line 22–92, `migrate()` ~line 313)
- Modify: `lib/types.ts` (`Project`, `Task`, `Feature`, `FeatureWithCounts`)
- Test: `tests/keys.test.ts` (append)

- [ ] **Step 1: Add the columns to the `CREATE TABLE` statements**

`projects`: `key TEXT NOT NULL DEFAULT ''` and `key_seq INTEGER NOT NULL DEFAULT 0`.
`tasks` and `features`: `seq INTEGER NOT NULL DEFAULT 0`.

Comment on `key_seq` explaining the monotonic rule (cross-reference
`nextServicePort()`, which makes the same never-reuse argument for ports).

- [ ] **Step 2: Add the migration entries in `migrate()`**

Follow the existing `if (!cols.includes(...))` style for the three new columns,
then a `settings`-guarded backfill modelled on `migrated_building_fold`
(`lib/db.ts:368`):

```ts
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migrated_keys'").get()) {
  const projects = db.prepare("SELECT id, name, key FROM projects").all();
  const taken = new Set(projects.map((p) => p.key).filter(Boolean));
  const setKey = db.prepare("UPDATE projects SET key = ?, key_seq = ? WHERE id = ?");
  const setTaskSeq = db.prepare("UPDATE tasks SET seq = ? WHERE id = ?");
  const setFeatSeq = db.prepare("UPDATE features SET seq = ? WHERE id = ?");
  db.transaction(() => {
    for (const p of projects) {
      const key = p.key || uniqueProjectKey(p.name, taken);
      taken.add(key);
      // Features and tasks numbered TOGETHER in created_at order: one counter,
      // so the numbers reflect the order things were actually filed.
      const rows = [
        ...db.prepare("SELECT id, created_at, 'f' AS kind FROM features WHERE project_id = ?").all(p.id),
        ...db.prepare("SELECT id, created_at, 't' AS kind FROM tasks WHERE project_id = ?").all(p.id),
      ].sort((a, b) => a.created_at - b.created_at);
      let n = 0;
      for (const r of rows) (r.kind === "f" ? setFeatSeq : setTaskSeq).run(++n, r.id);
      setKey.run(key, n, p.id);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_keys', '1')").run();
  })();
}
```

- [ ] **Step 3: Add the fields to `lib/types.ts`**

`Project`: `key: string; key_seq: number;`
`Task` / `Feature`: `seq: number;`
`FeatureWithCounts`: `merged_count: number; running_count: number;`

Each with the one-line comment style the surrounding fields use.

- [ ] **Step 4: Write the backfill test**

```ts
it("backfills keys and numbers features and tasks together by created_at", () => {
  // Insert rows with explicit created_at, run migrate(), assert the sequence.
});
```

Use `tests/helpers.ts` for the project fixture. Assert: the project gets a key,
an older feature gets a lower number than a newer task, and `key_seq` equals the
highest number handed out.

- [ ] **Step 5: Run it, then commit**

```bash
npx vitest run tests/keys.test.ts
git add lib/db.ts lib/types.ts tests/keys.test.ts
git commit -m "Give projects a key and number their tasks and features"
```

### Task 3: Allocation and read-time joining in the store

**Files:**
- Modify: `lib/store.ts` — `createProject`, `createTask`, `createFeature`, `updateProject`, `listTasks`, `listFeatures`, `listAllTasksLite`, `findFeature`
- Test: `tests/keys.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```ts
it("shares one counter between tasks and features", () => {
  // createTask -> -1, createFeature -> -2, createTask -> -3
});
it("never reuses a number after a delete", () => {
  // create, delete, create again -> the second gets the NEXT number, not the freed one
});
it("exposes the display key on listTasks and listFeatures rows", () => {});
it("resolves a feature by its key", () => {
  // findFeature(projectId, "TME-2") === the feature with seq 2
  // and it still resolves by id and by name
});
```

- [ ] **Step 2: Implement**

- `createProject`: `key: uniqueProjectKey(input.name, taken)` where `taken` is
  every existing project key. Add `key` to the INSERT.
- `bumpKeySeq(projectId)`: a private helper —
  `UPDATE projects SET key_seq = key_seq + 1 WHERE id = ?` then read it back,
  wrapped in the transaction that inserts the row. Used by both `createTask` and
  `createFeature`; add `seq` to both INSERTs.
- `updateProject`: add `key = ?` to its fixed column list (normalized;
  falls back to the current key when the patch omits it).
- `listTasks` / `listFeatures`: read the project's key once, then attach
  `key: displayKey(projectKey, row.seq)` in the `.map()` that already runs. **Do
  not** add a JOIN — these are already project-scoped.
- `listAllTasksLite`: it already joins `projects`; select `p.key` and `t.seq` and
  attach the same way.
- `listFeatures`: add `merged_count` and `running_count` to the rollup subquery:

```sql
SUM(CASE WHEN suggested = 0 AND status != 'cancelled' AND merged_at > 0 THEN 1 ELSE 0 END) AS merged_count,
SUM(CASE WHEN running = 1 THEN 1 ELSE 0 END) AS running_count,
```

- `findFeature`: between the id lookup and the name scan, try the key — parse
  `^([A-Za-z][A-Za-z0-9]*)-(\d+)$`, and if the prefix matches this project's key
  (case-insensitively), look up by `seq`.

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
npx vitest run tests/keys.test.ts tests/features.test.ts
npx tsc --noEmit
git add lib/store.ts tests/keys.test.ts
git commit -m "Allocate and resolve keys in the store"
```

### Task 4: Key editing and ship auto-archive

**Files:**
- Modify: `app/api/projects/[id]/route.ts` (PATCH)
- Modify: `app/api/features/[id]/ship/route.ts:59`

- [ ] **Step 1: Validate the key in `PATCH /api/projects/[id]`**

The route currently forwards the whole patch to `updateProject` with no
allowlist. Add: when `key` is present, `validateKey` it (400 on a bad shape) and
check no other project holds it case-insensitively (409, naming the clash).

- [ ] **Step 2: Auto-archive on ship**

`app/api/features/[id]/ship/route.ts:59` becomes:

```ts
// Shipping is the moment a feature is finished, so it also leaves the working
// set — the Archived section is where it stays reachable. Guarded by
// alreadyMerged for the same reason merged_at is: a re-ship changes nothing.
if (!res.alreadyMerged) updateFeature(feature.id, { merged_at: Date.now(), archived: 1 });
```

- [ ] **Step 3: Commit**

```bash
git add app/api
git commit -m "Validate project keys, and archive a feature when it ships"
```

---

## Chunk 2: The UI

### Task 5: Client shapes and the derived state

**Files:**
- Modify: `app/orchestrator/types.ts` (`ProjectRow`, `TaskRow`, `FeatureRow`, `PaletteTaskRow`)
- Modify: `app/orchestrator/format.ts`
- Test: `tests/featureState.test.ts`

- [ ] **Step 1: Mirror the server fields**

`ProjectRow.key`, `TaskRow.key`, `FeatureRow.key`, `PaletteTaskRow.key`,
`FeatureRow.merged_count`, `FeatureRow.running_count`.

- [ ] **Step 2: Write the failing test**

```ts
import { featureState } from "@/app/orchestrator/format";

const f = (over) => ({ merged_at: 0, branch: "", pr_url: "", total: 0, done: 0, merged_count: 0, running_count: 0, awaiting_count: 0, blocked_count: 0, ...over });

it("is shipped once the integration branch has landed", () =>
  expect(featureState(f({ branch: "feat/x", merged_at: 1 }))).toBe("shipped"));
it("is shipped with no branch when every member is done and merged", () =>
  expect(featureState(f({ total: 3, done: 3, merged_count: 3 }))).toBe("shipped"));
it("is only done when the members are done but not all merged", () =>
  expect(featureState(f({ total: 3, done: 3, merged_count: 1 }))).toBe("done"));
it("prefers shipped over in_review", () =>
  expect(featureState(f({ branch: "feat/x", merged_at: 1, pr_url: "http://x" }))).toBe("shipped"));
it("is in_review while a PR is open", () =>
  expect(featureState(f({ branch: "feat/x", pr_url: "http://x", total: 2, done: 2 }))).toBe("in_review"));
it("is building once anything has moved", () =>
  expect(featureState(f({ total: 3, running_count: 1 }))).toBe("building"));
it("is planned when nothing has", () =>
  expect(featureState(f({ total: 3 }))).toBe("planned"));
it("is planned when empty", () => expect(featureState(f({}))).toBe("planned"));
// A branch that hasn't merged must NOT take the no-branch shortcut.
it("is done, not shipped, when a branched feature's members are all merged into it", () =>
  expect(featureState(f({ branch: "feat/x", total: 2, done: 2, merged_count: 2 }))).toBe("done"));
```

- [ ] **Step 3: Implement `featureState` in `format.ts`**

```ts
export type FeatureState = "shipped" | "in_review" | "done" | "building" | "planned";
export const FEATURE_STATE_LABEL: Record<FeatureState, string> = {
  shipped: "Shipped", in_review: "In review", done: "Done", building: "", planned: "",
};

export function featureState(f: Pick<FeatureRow, "merged_at" | "branch" | "pr_url" | "total" | "done" | "merged_count" | "running_count" | "awaiting_count" | "blocked_count">): FeatureState {
  const allDone = f.total > 0 && f.done === f.total;
  // An integration branch has ONE landing event (merged_at). Without one, member
  // tasks merge individually, so "every member merged" is the same fact.
  if (f.merged_at > 0) return "shipped";
  if (!f.branch && allDone && f.merged_count === f.total) return "shipped";
  if (f.pr_url) return "in_review";
  if (allDone) return "done";
  if (f.running_count > 0 || f.done > 0 || f.awaiting_count > 0 || f.blocked_count > 0) return "building";
  return "planned";
}
export const isFinished = (s: FeatureState) => s === "shipped" || s === "done";
```

- [ ] **Step 4: Run, commit**

```bash
npx vitest run tests/featureState.test.ts
git add app/orchestrator/types.ts app/orchestrator/format.ts tests/featureState.test.ts
git commit -m "Derive a feature's shipped state from its rollup"
```

### Task 6: The tasks column — badge, keys, archived section

**Files:**
- Modify: `app/orchestrator/TasksColumn.tsx`

- [ ] **Step 1: `FeatureGroupHeader`** — render `feature.key` as a mono chip before
  the title, and a `fgh-state` pill for `shipped`/`in_review`/`done` (nothing for
  the other two). Root gets `data-state={state}` so CSS can desaturate a shipped
  tile. Add an Archive button (visible on hover, or always when finished) calling
  a new `onArchive` prop.

- [ ] **Step 2: `TaskCard`** — `task.key` chip in `.task-top`, before `.ttitle`.

- [ ] **Step 3: Archived features keep their tasks.** `inFeature()` currently
  tests membership against `activeFeatures`; change it to all `features` so an
  archived feature's tasks stay filed under it instead of scattering into the
  flat status groups.

- [ ] **Step 4: Sort and fold finished features.** `shownFeatures` sorts
  `isFinished(featureState(f))` last (stable, so manual position survives within
  each band). `FeatureGroup`'s `useCollapsed` default becomes
  `isFinished(state)`.

- [ ] **Step 5: The Archived section.** Below the Cancelled group: a collapsible
  header (`useCollapsed(`orch_archived_collapsed_${project.id}`, true)`) holding
  a `FeatureGroup` per archived feature, each with a Restore button. Render
  nothing when there are no archived features.

- [ ] **Step 6: Search matches keys.** `match()` gains
  `|| t.key.toLowerCase().includes(q)`, so `tme-42` and `42` both find it.

- [ ] **Step 7: Wire `onArchive`** through `Orchestrator.tsx` to the existing
  `saveFeature(id, { archived })` in `useOrchestrator.ts` — no new endpoint;
  `PATCH /api/features/[id]` already allows `archived`.

- [ ] **Step 8: Commit**

```bash
git add app/orchestrator/TasksColumn.tsx app/Orchestrator.tsx
git commit -m "Badge a shipped feature, and give archived features somewhere to live"
```

### Task 7: The remaining surfaces

**Files:**
- Modify: `app/orchestrator/TaskBoard.tsx` (key chip on the board card)
- Modify: `app/orchestrator/FeatureLanding.tsx` (key + state pill in the header)
- Modify: `app/orchestrator/SessionView.tsx:306` (key beside `.sh-title`)
- Modify: `app/orchestrator/CommandPalette.tsx` (key in the row and the rank text)
- Modify: `app/orchestrator/modals.tsx` (`ContextModal`: the Key field)

- [ ] **Step 1–5:** one surface at a time; the key chip is the same
  `<span className="key-chip">` everywhere.

- [ ] **Step 6: The Key field** in `ContextModal`, beside Name. Client-side
  `validateKey` disables Save and shows the reason; the hint says plainly that
  changing it re-keys every task and feature in the project. `ContextModal`'s
  `onSave` signature and its `Orchestrator.tsx` call site both gain `key`.

- [ ] **Step 7: Commit**

```bash
git add app/orchestrator
git commit -m "Show keys everywhere a task or feature is named"
```

### Task 8: Styles

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1:** `.key-chip` (mono, 9.5px, `--ink-4`, tabular numerals),
  `.fgh-state` variants keyed off `data-state`, a desaturated
  `.feat-group-h[data-state="shipped"]` with a full bar, and `.arch-group-h`.
  Follow the existing `.fgh-*` block at `app/globals.css:1539`.

- [ ] **Step 2: Commit**

```bash
git add app/globals.css
git commit -m "Style the key chips and the shipped badge"
```

### Task 9: Verify

- [ ] **Step 1:** `npx tsc --noEmit` — clean.
- [ ] **Step 2:** `npm test` — the whole serial suite, once, at the end.
- [ ] **Step 3:** Update `README.md` (the feature-layer section) with keys, the
      shipped badge, and the archived section.
- [ ] **Step 4:** Commit.
