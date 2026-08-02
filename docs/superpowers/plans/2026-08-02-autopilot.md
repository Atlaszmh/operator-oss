# Autopilot Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user approves a plan once; the feature's tasks then run in parallel, self-gate on tests + an independent reviewer agent, merge into the feature's integration branch, and arrive back as a pushed PR against the project branch.

**Architecture:** One controller (`lib/autopilot.ts`) driven off the existing global event bus, one gate module (`lib/gates.ts`) routing its reviewer through `lib/agents/oneshots.ts`, four new columns, three new routes. Every git operation reuses `lib/git.ts` as-is — `mergeTask` is already serialized by `withRepoLock`, so the merge queue exists already.

**Tech Stack:** Next.js App Router (server routes), better-sqlite3, `@anthropic-ai/claude-agent-sdk` via the driver seam, vitest (serial), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-08-02-autopilot-design.md`

---

## File Structure

| File | Responsibility |
|-|-|
| `lib/db.ts` | + 4 columns on `features`/`tasks`, in both `CREATE TABLE` and `migrate()` |
| `lib/types.ts` | + the 4 fields on `Feature`/`Task`, `blocked_count` on `FeatureWithCounts`, `GateVerdict` |
| `lib/store.ts` | new columns in the two UPDATE statements; `blocked_count` in `listFeatures`; `featureMembers()`, `readyMembers()` |
| `lib/config.ts` | `AUTOPILOT_CONCURRENCY`, `AUTOPILOT_ATTEMPTS` |
| `lib/features.ts` | `autopilot`, `autopilotShadow` flags |
| `lib/agents/types.ts` | `reviewTask?()` on `AgentDriver` |
| `lib/agents/shared.ts` | `buildReviewPrompt()` + `parseVerdict()` + `REVIEW_INSTRUCTION` (marker and parser together) |
| `lib/agents/claude/driver.ts` | `reviewTask` implementation (read-only agent loop in the worktree) |
| `lib/agents/oneshots.ts` | `reviewTask()` — project-scoped, utility agent |
| `lib/gates.ts` | **new** — `runGate()`: test_command in the worktree, then the reviewer |
| `lib/autopilot.ts` | **new** — `sweep()`, `ensureAutopilot()`, the scheduler |
| `lib/github.ts` | `createBranchPr()` generalized out of `createTaskPr()`; `buildFeaturePrBody()` |
| `app/api/features/[id]/approve-plan/route.ts` | **new** — gate 1 |
| `app/api/features/[id]/pr/route.ts` | **new** — push + PR (also manual) |
| `app/api/features/[id]/route.ts` | PATCH accepts `autopilot` |
| `app/api/events/route.ts` | calls `ensureAutopilot()` |
| `app/api/recaps/sweep/route.ts` | calls the autopilot safety sweep |
| `app/orchestrator/FeatureLanding.tsx` | Approve plan / pause / PR link / blocked list |
| `tests/autopilot.test.ts` | **new** — the scheduler + gate contract |
| `.env.example`, `README.md`, `CLAUDE.md` | document the knobs and the new subsystem |

---

## Chunk 1: Schema and store

### Task 1: Columns

**Files:**
- Modify: `lib/db.ts` (features + tasks `CREATE TABLE`, `migrate()`)
- Modify: `lib/types.ts`
- Modify: `lib/store.ts` (`updateFeature`, `updateTask`, `listFeatures`)
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/autopilot.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createProject, createFeature, createTask, updateFeature, updateTask, listFeatures, getFeature, getTask } from "@/lib/store";

describe("autopilot schema", () => {
  it("defaults autopilot off and round-trips the new columns", () => {
    const p = createProject({ name: "S" });
    const f = createFeature({ project_id: p.id, name: "F" });
    expect(f.autopilot).toBe(0);
    expect(f.pr_url).toBe("");

    updateFeature(f.id, { autopilot: 1, pr_url: "https://example/pull/1" });
    expect(getFeature(f.id)).toMatchObject({ autopilot: 1, pr_url: "https://example/pull/1" });

    const t = createTask({ project_id: p.id, title: "T", feature_id: f.id });
    expect(t.gate_attempts).toBe(0);
    expect(t.blocked_reason).toBe("");
    updateTask(t.id, { gate_attempts: 2, blocked_reason: "gate failed twice" });
    expect(getTask(t.id)).toMatchObject({ gate_attempts: 2, blocked_reason: "gate failed twice" });
  });

  it("counts blocked members in listFeatures", () => {
    const p = createProject({ name: "S2" });
    const f = createFeature({ project_id: p.id, name: "F2" });
    const t = createTask({ project_id: p.id, title: "T", feature_id: f.id });
    updateTask(t.id, { blocked_reason: "stuck" });
    expect(listFeatures(p.id).find((x) => x.id === f.id)!.blocked_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: FAIL — `autopilot` is not a property of the created feature.

- [ ] **Step 3: Add the columns**

`lib/db.ts` — in the `features` CREATE TABLE, after `merged_at`:

```sql
      -- Autopilot: 1 = this feature's approved plan runs unattended (see
      -- lib/autopilot.ts). 0 is the pre-autopilot behaviour, byte for byte.
      -- pr_url is the integration branch's open PR — set = awaiting the user's
      -- review, which is the terminal state autopilot drives toward.
      autopilot   INTEGER NOT NULL DEFAULT 0,
      pr_url      TEXT NOT NULL DEFAULT '',
```

In the `tasks` CREATE TABLE, next to the other run-state columns:

```sql
      -- Autopilot gate bookkeeping. gate_attempts counts consumed retries of the
      -- tests+review gate; blocked_reason ('' = not blocked) is why autopilot
      -- stopped touching this task, and is cleared by any human message.
      gate_attempts  INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT NOT NULL DEFAULT '',
```

In `migrate()`, after the existing task-column block:

```ts
  if (!taskCols.includes("gate_attempts")) db.exec("ALTER TABLE tasks ADD COLUMN gate_attempts INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("blocked_reason")) db.exec("ALTER TABLE tasks ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT ''");

  // Autopilot columns on features (added after the feature layer shipped).
  const featureCols = (db.prepare("PRAGMA table_info(features)").all() as { name: string }[]).map((c) => c.name);
  if (!featureCols.includes("autopilot")) db.exec("ALTER TABLE features ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0");
  if (!featureCols.includes("pr_url")) db.exec("ALTER TABLE features ADD COLUMN pr_url TEXT NOT NULL DEFAULT ''");
```

- [ ] **Step 4: Add the type fields**

`lib/types.ts` — on `Feature`, after `merged_at`:

```ts
  autopilot: number; // 1 = the approved plan runs unattended (lib/autopilot.ts)
  pr_url: string; // the integration branch's open PR ("" = none); set = awaiting your review
```

On `Task`, after `pr_url`:

```ts
  gate_attempts: number; // consumed autopilot gate retries (reset by any human message)
  blocked_reason: string; // why autopilot stopped working this task ("" = not blocked)
```

On `FeatureWithCounts`, after `awaiting_count`:

```ts
  blocked_count: number; // members autopilot has escalated and stopped working
```

Add the verdict shape at the end of the file:

```ts
// One gate decision for a task (lib/gates.ts): did it earn an unattended merge?
// `feedback` is what gets sent back to the agent on a failure, so it must read
// as instructions, not as a report about the agent.
export interface GateVerdict {
  ok: boolean;
  feedback: string;
  testsRan: boolean;
  reviewRan: boolean;
}
```

- [ ] **Step 5: Widen the two UPDATE statements**

`lib/store.ts` `updateFeature` — add `autopilot=?, pr_url=?` before `position=?`, and the matching `n.autopilot, n.pr_url` args in the same position.

`lib/store.ts` `updateTask` — add `gate_attempts=?, blocked_reason=?` before `generation=?`, with `n.gate_attempts ?? 0, n.blocked_reason ?? ""` in the same position.

> Both statements enumerate every column; a new column that isn't added here is silently never persisted. This is the single most likely place to get this task wrong.

- [ ] **Step 6: Add `blocked_count` to `listFeatures`**

In the grouped subquery, alongside `awaiting_count`:

```sql
           SUM(CASE WHEN blocked_reason != ''                   THEN 1 ELSE 0 END) AS blocked_count,
```

and in the outer select: `COALESCE(c.blocked_count, 0) AS blocked_count,`

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Commit**

```bash
git add lib/db.ts lib/types.ts lib/store.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): add the schema autopilot needs

features.autopilot is the per-feature switch (0 = today's behaviour byte for
byte); features.pr_url mirrors tasks.pr_url and marks the terminal
awaiting-review state. tasks.gate_attempts/blocked_reason are the gate's
bookkeeping. No features.autopilot_state column: derivable in listFeatures,
and a stored status would drift exactly as the feature-layer design argued."
```

### Task 2: Store queries the scheduler needs

**Files:**
- Modify: `lib/store.ts`
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("readyMembers", () => {
  it("excludes suggested, running, blocked, terminal, and dep-blocked tasks", () => {
    const p = createProject({ name: "R" });
    const f = createFeature({ project_id: p.id, name: "RF" });
    const mk = (title: string, patch = {}) => {
      const t = createTask({ project_id: p.id, title, feature_id: f.id });
      if (Object.keys(patch).length) updateTask(t.id, patch);
      return t;
    };
    const ready = mk("ready");
    mk("suggested-one", { suggested: 1 });
    mk("running-one", { running: 1 });
    mk("blocked-one", { blocked_reason: "stuck" });
    mk("done-one", { status: "done" });
    const dep = mk("dep");                    // not done
    const blockedByDep = mk("after-dep");
    setTaskDeps(blockedByDep.id, [dep.id]);

    const ids = readyMembers(f.id).map((t) => t.id);
    expect(ids).toContain(ready.id);
    expect(ids).toContain(dep.id);
    expect(ids).not.toContain(blockedByDep.id);
    expect(ids).toHaveLength(2);

    updateTask(dep.id, { status: "done" });
    expect(readyMembers(f.id).map((t) => t.id)).toContain(blockedByDep.id);
  });
});
```

Add `setTaskDeps` and `readyMembers` to the file's imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/autopilot.test.ts -t readyMembers`
Expected: FAIL — `readyMembers is not a function`

- [ ] **Step 3: Implement**

`lib/store.ts`, in the features section after `featureUnfinishedTasks`:

```ts
// Every task filed under a feature, in the project's manual order. The
// scheduler's unit of work — autopilot never looks at ungrouped tasks.
export function featureMembers(featureId: string): Task[] {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE feature_id = ? ORDER BY position ASC, created_at ASC")
    .all(featureId) as Task[];
}

/**
 * Members autopilot may start right now: committed (not suggested), not already
 * running, not escalated, not finished, and with every dependency done.
 *
 * The dependency filter is the whole reason task_dependencies existed without a
 * consumer — a planner could always express ordering, and until now nothing read
 * it back. A dep pointing at a deleted or foreign task can't be satisfied and is
 * treated as unmet; setTaskDeps already refuses foreign ids on write, and the
 * cascade removes them on delete, so this only guards the impossible case.
 */
export function readyMembers(featureId: string): Task[] {
  const members = featureMembers(featureId);
  const done = new Set(members.filter((t) => t.status === "done").map((t) => t.id));
  return members.filter(
    (t) =>
      !t.suggested &&
      !t.running &&
      !t.blocked_reason &&
      t.status !== "done" &&
      t.status !== "cancelled" &&
      t.status !== "on_hold" &&
      getTaskDeps(t.id).every((id) => done.has(id))
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): featureMembers + readyMembers

readyMembers is the first consumer task_dependencies has ever had: the graph
was writable via suggest_task({blocked_by}) and rendered as a badge, but
nothing scheduled off it."
```

---

## Chunk 2: The gate

### Task 3: Review prompt and parser

**Files:**
- Modify: `lib/agents/shared.ts`
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("parseVerdict", () => {
  it("reads a PASS verdict and fails closed on a missing marker", () => {
    expect(parseVerdict("looks fine\nVERDICT: PASS").ok).toBe(true);
    expect(parseVerdict("**VERDICT:** FAIL\nmissing the migration").ok).toBe(false);
    expect(parseVerdict("no marker at all").ok).toBe(false);
    expect(parseVerdict("VERDICT: FAIL\nnotes here").notes).toContain("notes here");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/autopilot.test.ts -t parseVerdict`
Expected: FAIL — `parseVerdict is not a function`

- [ ] **Step 3: Implement, next to `buildConflictPrompt`**

```ts
// The reviewer's verdict marker and its parser, together — same rule as
// OUTCOME_INSTRUCTION/extractOutcome above: a marker whose parser lives in
// another file drifts the first time either is edited.
export const REVIEW_INSTRUCTION =
  `End your reply with a line of exactly "VERDICT: PASS" or "VERDICT: FAIL" and nothing else on it. ` +
  `PASS means this change can be merged unattended. FAIL means a human or another turn must act first. ` +
  `Put your reasoning ABOVE that line; on a FAIL, state precisely what must change, as instructions to the ` +
  `engineer who will fix it.`;

const VERDICT_RE = /^[ \t>#*_-]*verdict[ \t*_]*:[ \t]*\**(pass|fail)\b/im;

/**
 * Read a reviewer's verdict. **Fails closed**: a reply with no parseable marker
 * is a FAIL, because the alternative is that a malformed or truncated review
 * silently merges code. The notes are everything above the marker — that text
 * becomes the follow-up turn's instructions.
 */
export function parseVerdict(text: string): { ok: boolean; notes: string } {
  const m = VERDICT_RE.exec(text);
  const notes = (m ? text.slice(0, m.index) : text).trim();
  if (!m) return { ok: false, notes: notes || "the reviewer returned no verdict" };
  return { ok: m[1].toLowerCase() === "pass", notes };
}

/**
 * The reviewer's prompt. It sees the task's own brief, the feature spec that
 * brief was cut from, and the diff — deliberately in that order, so "did this
 * build the right thing" is answerable before "is the code any good".
 */
export function buildReviewPrompt(input: {
  taskTitle: string;
  taskDescription: string;
  featureContext: string;
  projectContext: string;
  diff: string;
  testOutput: string;
}): string {
  return [
    `You are reviewing one engineer's completed task before it is merged WITHOUT human review.`,
    `Be the last line of defence: approve work that does what was asked and is safe to land; reject`,
    `work that is incomplete, does something other than what was asked, breaks an existing contract,`,
    `leaves debug/placeholder code, or ships an obvious bug. Do not reject over style preferences,`,
    `and do not ask for work nobody requested — scope creep is a FAIL in the other direction.`,
    ``,
    `=== PROJECT CONTEXT ===\n${input.projectContext || "(none)"}`,
    ``,
    `=== FEATURE SPEC (what the whole feature is for) ===\n${input.featureContext || "(none)"}`,
    ``,
    `=== THIS TASK ===\n${input.taskTitle}\n${input.taskDescription || "(no description)"}`,
    ``,
    `=== TEST RUN ===\n${input.testOutput || "(no test command configured)"}`,
    ``,
    `=== DIFF ===\n${input.diff || "(empty diff — that alone is a FAIL unless the task was investigative)"}`,
    ``,
    REVIEW_INSTRUCTION,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): review prompt + fail-closed verdict parser

Marker and parser live together, same rule as OUTCOME_INSTRUCTION. Fails
closed on a missing verdict: an unparseable review must never merge code."
```

### Task 4: `reviewTask` on the driver seam

**Files:**
- Modify: `lib/agents/types.ts`, `lib/agents/claude/driver.ts`, `lib/agents/oneshots.ts`

- [ ] **Step 1: Extend the interface**

`lib/agents/types.ts`, after `summarizeProjectRecap`:

```ts
  /** Judge a finished task's diff against its brief. Read-only; returns the raw
   *  reply, which the caller parses with parseVerdict(). */
  reviewTask?(prompt: string, cwd: string): Promise<string>;
```

Widen the comment above the block from "All three are OPTIONAL" to "All of these are OPTIONAL".

- [ ] **Step 2: Implement in the Claude driver**

`lib/agents/claude/driver.ts`, after `summarizeProjectRecap`. A read-only agent loop, modelled on `draftProjectContext` — the reviewer must be able to open the files around a hunk, not just read the patch:

```ts
/**
 * Review one task's diff against its brief (autopilot's done gate). A short
 * READ-ONLY agent loop in the task's own worktree, so the reviewer can open the
 * files a hunk touches instead of judging a patch in isolation. Returns the raw
 * reply; parseVerdict() in lib/agents/shared.ts reads the decision out of it.
 */
async function reviewTask(prompt: string, cwd: string): Promise<string> {
  const response = query({
    prompt,
    options: {
      cwd: cwd || process.cwd(),
      allowedTools: ["Read", "Grep", "Glob"],
      maxTurns: 12,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
    },
  });

  let out = "";
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    }
  }
  return out.trim();
}
```

Register it on `claudeDriver` next to `summarizeProjectRecap`.

- [ ] **Step 3: Route it through oneshots**

`lib/agents/oneshots.ts` — add `"reviewTask"` to `OneShotKey`, and:

```ts
/** Autopilot's done-gate review — PROJECT-scoped (utility agent), deliberately
 *  NOT the task's own agent: a model must not grade its own homework. */
export async function reviewTask(prompt: string, cwd: string): Promise<string> {
  return resolve(utilityDriver(), "reviewTask")(prompt, cwd);
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/
git commit -m "feat(autopilot): reviewTask one-shot on the driver seam

Project-scoped so it runs on the utility agent, not the task's own — the
reviewer must not be the model that wrote the code. Optional like every other
one-shot, so a driver shipping runTurn() alone is backstopped."
```

### Task 5: `lib/gates.ts`

**Files:**
- Create: `lib/gates.ts`
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("runGate", () => {
  it("fails when the test command fails, without calling the reviewer", async () => {
    const { project, feature, task } = await gateFixture({ test_command: "exit 1" });
    const v = await runGate(task, project, feature);
    expect(v.ok).toBe(false);
    expect(v.testsRan).toBe(true);
    expect(v.reviewRan).toBe(false);
    expect(v.feedback).toMatch(/test command failed/i);
  });

  it("notes a missing test command instead of silently passing that half", async () => {
    const { project, feature, task } = await gateFixture({ test_command: "" });
    const v = await runGate(task, project, feature);
    expect(v.testsRan).toBe(false);
    expect(v.feedback).toMatch(/no test command/i);
  });
});
```

`gateFixture` builds a project with a real git repo (`tests/helpers.ts`), a feature, and a started task with a worktree. Mock `lib/agents/oneshots.ts`'s `reviewTask` with `vi.mock` so the reviewer half is deterministic.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/autopilot.test.ts -t runGate`
Expected: FAIL — module `@/lib/gates` not found.

- [ ] **Step 3: Implement**

```ts
// Autopilot's done gate: what must be true for a task to merge without anyone
// reading its transcript. Two halves, both required — the tests prove it RUNS,
// the reviewer proves it's the RIGHT THING. Neither alone is enough to merge on:
// a green suite says nothing about whether the task was understood, and a
// reviewer reading a diff can approve code that doesn't execute.
//
// A failure is never fatal here — it comes back as `feedback` phrased as
// instructions, which lib/autopilot.ts sends into the task as an ordinary turn.

import { spawn } from "node:child_process";
import { taskDiff } from "./git";
import { reviewTask } from "./agents/oneshots";
import { buildReviewPrompt, parseVerdict, clip } from "./agents/shared";
import { getFeature } from "./store";
import { resolveFeatures } from "./features";
import { GATE_TEST_TIMEOUT_MS } from "./config";
import type { Feature, GateVerdict, Project, Task } from "./types";

/** Cap on captured test output. The reviewer sees this, and a 200k-line suite
 *  log would crowd the diff out of its context window. Tail, not head — the
 *  failure summary is at the bottom of every runner's output. */
const TEST_OUTPUT_CHARS = 6000;

interface TestRun {
  ran: boolean;
  ok: boolean;
  output: string;
}

/**
 * Run the project's test command in the TASK'S WORKTREE. Deliberately not
 * lib/services.ts, which spawns with cwd = project.repo_path (services.ts:466):
 * gating the shared tree would prove nothing about the isolated branch we're
 * about to merge. One-shot child with a hard timeout, not a supervised service.
 */
async function runTests(project: Project, task: Task): Promise<TestRun> {
  const cmd = project.test_command?.trim();
  if (!cmd) return { ran: false, ok: true, output: "" };
  if (!task.worktree_path) return { ran: false, ok: true, output: "" };

  return new Promise<TestRun>((resolve) => {
    const child = spawn(cmd, {
      cwd: task.worktree_path,
      shell: true,
      detached: true, // own process group, so the timeout can kill the whole tree
      env: { ...process.env, CI: "1", PORT: String(project.port || "") },
    });
    let out = "";
    const take = (b: Buffer) => {
      out += b.toString();
      if (out.length > TEST_OUTPUT_CHARS * 4) out = out.slice(-TEST_OUTPUT_CHARS * 2);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      settle(false, `${out}\n[gate] test command exceeded ${GATE_TEST_TIMEOUT_MS / 1000}s and was killed`);
    }, GATE_TEST_TIMEOUT_MS);

    let done = false;
    const settle = (ok: boolean, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ran: true, ok, output: text.slice(-TEST_OUTPUT_CHARS) });
    };

    child.on("error", (e) => settle(false, `${out}\n[gate] could not run the test command: ${e.message}`));
    child.on("close", (code) => settle(code === 0, out));
  });
}

/**
 * The full gate for one finished task. Short-circuits: a red suite skips the
 * reviewer, because there is nothing for a reviewer to usefully say about code
 * that doesn't pass its own tests, and the review is the expensive half.
 */
export async function runGate(task: Task, project: Project, feature: Feature | undefined): Promise<GateVerdict> {
  const tests = await runTests(project, task);
  if (tests.ran && !tests.ok) {
    return {
      ok: false,
      testsRan: true,
      reviewRan: false,
      feedback:
        `The test command \`${project.test_command}\` failed in your worktree. Fix it — that means making the ` +
        `code correct, not deleting or skipping the failing test. Output:\n\n\`\`\`\n${tests.output}\n\`\`\``,
    };
  }

  const diff = await taskDiff(project.repo_path, task.worktree_path, task.base_sha, feature?.branch || project.branch)
    .then((d) => d.files.map((f) => `--- ${f.path}\n${f.patch ?? ""}`).join("\n"))
    .catch(() => "");

  const prompt = buildReviewPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    featureContext: feature?.context ?? "",
    projectContext: project.context,
    diff: clip(diff, 60_000),
    testOutput: tests.ran ? `exit 0\n${tests.output}` : "(no test command configured for this project)",
  });

  const raw = await reviewTask(prompt, task.worktree_path || project.repo_path);
  const verdict = parseVerdict(raw);
  const noTests = tests.ran ? "" : "\n\n(Note: this project has no test command, so nothing proved the change runs.)";

  return {
    ok: verdict.ok,
    testsRan: tests.ran,
    reviewRan: true,
    feedback: verdict.ok
      ? verdict.notes
      : `Review did not pass, so this task was not merged. Address the following, then finish:\n\n${verdict.notes}${noTests}`,
  };
}

/** Shadow mode: run the whole gate and record the verdict, but never merge on
 *  it. The reviewer's judgment is calibrated against real work before it is
 *  trusted to land code — see §8 of the design. */
export const gateIsAdvisory = () => resolveFeatures().autopilotShadow;
```

- [ ] **Step 4: Add the config knob**

`lib/config.ts`:

```ts
/**
 * Hard timeout for an autopilot gate's test run, in ms. A hung suite must not
 * pin a queue slot forever; the task escalates instead. (10 minutes.)
 */
export const GATE_TEST_TIMEOUT_MS = process.env.ORCH_GATE_TEST_TIMEOUT_MS
  ? Number(process.env.ORCH_GATE_TEST_TIMEOUT_MS)
  : 10 * 60 * 1000;
```

- [ ] **Step 5: Add the feature flags**

`lib/features.ts` — extend `Features`, `DEFAULT_FEATURES`, and `resolveFeatures`:

```ts
  /** Autopilot (lib/autopilot.ts): the Approve plan button, the per-feature
   *  switch, and the scheduler. Off until proven; ORCH_FEATURE_AUTOPILOT=1. */
  autopilot: boolean;
  /** Autopilot runs its full gate and records the verdict but never merges on
   *  it — the user still clicks. The recommended first weeks of autopilot:
   *  it calibrates the reviewer against real work before trusting it. */
  autopilotShadow: boolean;
```

```ts
  autopilot: false,
  autopilotShadow: true,
```

```ts
    autopilot: flag(process.env.ORCH_FEATURE_AUTOPILOT, DEFAULT_FEATURES.autopilot),
    autopilotShadow: flag(process.env.ORCH_FEATURE_AUTOPILOT_SHADOW, DEFAULT_FEATURES.autopilotShadow),
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/gates.ts lib/config.ts lib/features.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): the done gate

test_command in the task's WORKTREE (services.ts runs in repo_path, which
would prove nothing about the branch being merged), then the reviewer one-shot.
Red suite short-circuits the expensive half. Ships behind a flag, in shadow
mode by default."
```

---

## Chunk 3: The controller

### Task 6: `lib/autopilot.ts`

**Files:**
- Create: `lib/autopilot.ts`
- Modify: `lib/config.ts`
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing tests**

Mock the driver at the SDK boundary as `tests/agentDriver.test.ts` does, and `vi.mock("@/lib/gates")` so verdicts are scripted. Cases:

```
- starts only ready members, never more than AUTOPILOT_CONCURRENCY at once
- a dep-blocked member is not started until its dependency is status=done
- a failing verdict sends a follow-up turn and increments gate_attempts
- at the attempt cap the member gets blocked_reason and no further turns
- a blocked member does not stop an independent sibling from starting
- a passing verdict merges into the feature branch and sets status=done
- the last member landing opens the feature PR exactly once
- autopilot=0 makes sweep() a no-op
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: FAIL — module `@/lib/autopilot` not found.

- [ ] **Step 3: Implement**

```ts
// The autopilot controller: the thing that walks an approved plan so the user
// doesn't have to. Everything it does is something the user could do by hand
// today — start a task, run the tests, read the diff, merge, open a PR. It just
// does them without being asked, and stops the moment it can't.
//
// Driven by EVENTS, not a timer: subscribeGlobal() already broadcasts turn_end
// for every task in every project, and a turn ending is precisely when there is
// new work to consider. A slow safety sweep (the recap sweep's cadence) covers
// the one case events can't — a server restart with a queue mid-flight.
//
// sweep() is idempotent and serialized per project, so the two triggers
// overlapping is harmless.

import { getProject, getFeature, getTask, listFeatures, listProjects, updateTask, updateFeature,
         featureMembers, readyMembers, addMessage, recordTaskMerge, taskBaseBranch } from "./store";
import { startTurn } from "./runner";
import { runGate, gateIsAdvisory } from "./gates";
import { mergeTask, fastForwardWorktree } from "./git";
import { createBranchPr, buildFeaturePrBody } from "./github";
import { buildConflictPrompt } from "./agents/shared";
import { subscribeGlobal, publishGlobal } from "./events";
import { hasTurn } from "./abort";
import { withTaskLock } from "./taskLock";
import { markBusy } from "./idle";
import { resolveFeatures } from "./features";
import { AUTOPILOT_CONCURRENCY, AUTOPILOT_ATTEMPTS } from "./config";
import type { Feature, Project, Task } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __orchAutopilot: { armed: boolean; running: Set<string>; again: Set<string> } | undefined;
}

function state() {
  if (!global.__orchAutopilot) global.__orchAutopilot = { armed: false, running: new Set(), again: new Set() };
  return global.__orchAutopilot;
}

/**
 * Arm the event subscription. Idempotent and cheap, so every entry point that
 * could be the first thing to happen after a boot calls it: the approve-plan
 * route, the always-open /api/events stream, and the recap sweep. There is no
 * server-boot hook available to us — server.js is plain CommonJS and can't
 * import this file — so "arm on first touch" is the available shape.
 */
export function ensureAutopilot(): void {
  const st = state();
  if (st.armed) return;
  st.armed = true;
  subscribeGlobal((taskId, ev) => {
    if ((ev as { type?: string }).type !== "turn_end") return;
    const task = getTask(taskId);
    if (task?.feature_id) void sweep(task.project_id).catch(() => {});
  });
}

/** One idempotent pass over a project's autopilot features. */
export async function sweep(projectId: string): Promise<void> {
  if (!resolveFeatures().autopilot) return;
  const st = state();
  // Already sweeping this project — mark it dirty so the in-flight pass runs
  // again rather than two passes racing to start the same task.
  if (st.running.has(projectId)) {
    st.again.add(projectId);
    return;
  }
  st.running.add(projectId);
  try {
    do {
      st.again.delete(projectId);
      await sweepOnce(projectId);
    } while (st.again.has(projectId));
  } finally {
    st.running.delete(projectId);
    st.again.delete(projectId);
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
    } catch {
      // One wedged feature must never abort the sweep for the others — the same
      // best-effort rule sweepRecaps() follows.
    }
  }
}

async function driveFeature(project: Project, feature: Feature): Promise<void> {
  const members = featureMembers(feature.id);

  // 1. Gate anything that has finished a turn and is sitting on the user.
  for (const t of members) {
    if (t.running || hasTurn(t.id) || t.blocked_reason) continue;
    if (!t.started || t.suggested) continue;
    if (t.status === "done" || t.status === "cancelled") continue;
    if (!t.awaiting_input) continue; // mid-flight, or never handed back
    markBusy();
    await gateAndLand(project, feature, t);
  }

  // 2. Start ready members up to the cap.
  const fresh = featureMembers(feature.id);
  const live = fresh.filter((t) => t.running || hasTurn(t.id)).length;
  let slots = Math.max(0, AUTOPILOT_CONCURRENCY - live);
  for (const t of readyMembers(feature.id)) {
    if (slots <= 0) break;
    if (t.started) continue; // already underway; gating owns it from here
    markBusy();
    await launch(project, t);
    slots--;
  }

  // 3. Everything landed → hand it back to the user as a PR.
  await maybeOpenPr(project, feature);
}

/** Kick off a task's first turn. The description IS the prompt — it's what the
 *  planner wrote for exactly this purpose. */
async function launch(project: Project, task: Task): Promise<void> {
  await withTaskLock(task.id, async () => {
    const fresh = getTask(task.id);
    if (!fresh || fresh.running || hasTurn(fresh.id) || fresh.started) return;
    const text = [fresh.title, fresh.description].filter(Boolean).join("\n\n");
    const msg = addMessage(fresh.id, fresh.generation, "user", text);
    updateTask(fresh.id, { running: 1, suggested: 0, awaiting_input: 0 });
    startTurn({ ...fresh, running: 1 }, project, msg.content, "");
  });
}

/**
 * Gate one finished task and, if it passes, land it. A failure is a follow-up
 * turn, not an error: the task keeps its session and is told what to fix.
 */
async function gateAndLand(project: Project, feature: Feature, task: Task): Promise<void> {
  const verdict = await runGate(task, project, feature);

  if (!verdict.ok) {
    const attempts = task.gate_attempts + 1;
    if (attempts > AUTOPILOT_ATTEMPTS) {
      block(task, `The gate failed ${attempts - 1} times. Last verdict:\n\n${verdict.feedback}`);
      return;
    }
    updateTask(task.id, { gate_attempts: attempts });
    await sendTurn(project, task, verdict.feedback);
    return;
  }

  // Shadow mode: the verdict is the product, the merge isn't. Record it and
  // hand back to the user rather than landing on an unproven reviewer.
  if (gateIsAdvisory()) {
    note(task, `✓ Autopilot gate passed (shadow mode — not merged).\n\n${verdict.feedback}`);
    block(task, "Gate passed in shadow mode — merge when you're happy with it.");
    return;
  }

  await land(project, feature, task);
}

async function land(project: Project, feature: Feature, task: Task): Promise<void> {
  const base = taskBaseBranch(task, project);
  if (!task.worktree_path || !task.work_branch) {
    // Nothing isolated to merge (a task that ran in the repo directly). The work
    // is already on the base branch; just close it out.
    updateTask(task.id, { status: "done", awaiting_input: 0 });
    return;
  }

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
      // Hand the conflict to the task's OWN agent, as an ordinary message —
      // exactly the path the client takes today for a manual conflict, moved
      // server-side. It re-gates when that turn ends.
      const attempts = task.gate_attempts + 1;
      if (attempts > AUTOPILOT_ATTEMPTS) {
        block(task, `Merge into ${base} conflicts in ${result.conflicts.length} file(s) and the agent could not resolve it.`);
        return;
      }
      updateTask(task.id, { gate_attempts: attempts });
      await sendTurn(project, task, buildConflictPrompt(base, result.conflicts));
      return;
    }
    block(task, `Merge into ${base} failed: ${result.error ?? "unknown error"}`);
    return;
  }

  updateTask(task.id, {
    status: "done",
    awaiting_input: 0,
    merged_at: Date.now(),
    gate_attempts: 0,
    ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
  });
  if (!result.alreadyMerged)
    recordTaskMerge({
      project_id: project.id, task_id: task.id, agent: task.agent,
      additions: result.additions ?? 0, deletions: result.deletions ?? 0,
    });
  note(task, `✓ Autopilot merged this into ${base}.`);
}

/** Every member landed → push the integration branch and open the PR. */
async function maybeOpenPr(project: Project, feature: Feature): Promise<void> {
  if (!feature.branch || feature.pr_url) return;
  const members = featureMembers(feature.id);
  if (!members.length) return;
  const open = members.filter((t) => !t.suggested && t.status !== "done" && t.status !== "cancelled");
  if (open.length) return;

  const res = await createBranchPr({
    cwd: project.repo_path,
    branch: feature.branch,
    baseBranch: project.branch,
    title: feature.name,
    body: buildFeaturePrBody({
      context: feature.context,
      description: feature.description,
      outcomes: members.filter((t) => t.status === "done").map((t) => ({ title: t.title, outcome: t.outcome })),
      featureId: feature.id,
    }),
  });

  if (res.ok && res.url) {
    updateFeature(feature.id, { pr_url: res.url });
    return;
  }
  // The work is safe on the integration branch either way; surface the reason on
  // the last member so it reaches the "needs you" pill rather than a log nobody reads.
  const last = members[members.length - 1];
  if (last) block(last, `Every task landed, but opening the feature PR failed: ${res.error ?? "unknown error"}`);
}

// ---------- small helpers ----------

/** Send text into a task as an ordinary turn (the same path a typed message takes). */
async function sendTurn(project: Project, task: Task, text: string): Promise<void> {
  await withTaskLock(task.id, async () => {
    const fresh = getTask(task.id);
    if (!fresh || fresh.running || hasTurn(fresh.id)) return;
    const msg = addMessage(fresh.id, fresh.generation, "user", text);
    updateTask(fresh.id, { running: 1, awaiting_input: 0 });
    startTurn({ ...fresh, running: 1 }, project, msg.content, "");
  });
}

/** A quiet system line in the transcript — what autopilot did, in the user's view. */
function note(task: Task, text: string): void {
  addMessage(task.id, task.generation, "system", text);
}

/**
 * Stop working this task and put it in front of the user. Uses the durable-notice
 * pattern of lib/promptLimits.ts / lib/authFailure.ts: a persisted transcript line
 * plus awaiting_input, so it lights up the existing "N need you" pill with no new
 * notification surface. Cleared by any human message (see the messages route).
 */
function block(task: Task, reason: string): void {
  updateTask(task.id, { blocked_reason: reason, awaiting_input: 1, running: 0 });
  addMessage(task.id, task.generation, "system", `⏸ Autopilot stopped here.\n\n${reason}`);
  publishGlobal(task.id, { type: "task_updated" });
}

/** The slow safety net: resume any project whose queue was mid-flight at restart. */
export async function sweepAutopilot(): Promise<void> {
  if (!resolveFeatures().autopilot) return;
  ensureAutopilot();
  for (const p of listProjects()) await sweep(p.id).catch(() => {});
}
```

- [ ] **Step 4: Add the two config knobs**

```ts
/**
 * How many of one feature's tasks autopilot runs at once. Parallel where the
 * dependency graph allows; the cap is what keeps a twenty-task plan from
 * spawning twenty sessions. Per-feature overrides are deliberately not a thing
 * (see the design's non-goals) — raise this if 2 is too slow.
 */
export const AUTOPILOT_CONCURRENCY = process.env.ORCH_AUTOPILOT_CONCURRENCY
  ? Number(process.env.ORCH_AUTOPILOT_CONCURRENCY)
  : 2;

/**
 * How many times a task may fail its gate (or a merge conflict) before autopilot
 * stops and escalates. Low on purpose: an agent that hasn't fixed it in two
 * rounds is usually missing context only the user has, and further rounds just
 * spend quota. Empirical — expect to tune it.
 */
export const AUTOPILOT_ATTEMPTS = process.env.ORCH_AUTOPILOT_ATTEMPTS
  ? Number(process.env.ORCH_AUTOPILOT_ATTEMPTS)
  : 2;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/autopilot.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/autopilot.ts lib/config.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): the controller

Event-driven off subscribeGlobal's turn_end, serialized per project, idempotent
so the safety sweep can overlap it. Escalation reuses the durable-notice pattern
from promptLimits/authFailure, so a blocked task lights up the existing 'needs
you' pill with no new notification surface."
```

---

## Chunk 4: The handoff

### Task 7: `createBranchPr`

**Files:**
- Modify: `lib/github.ts`
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing test for the body builder**

```ts
describe("buildFeaturePrBody", () => {
  it("stacks the spec and every member's outcome line", () => {
    const body = buildFeaturePrBody({
      context: "The spec.",
      description: "Short label.",
      outcomes: [{ title: "A", outcome: "Users can log in." }, { title: "B", outcome: "" }],
      featureId: "f1",
    });
    expect(body).toContain("The spec.");
    expect(body).toContain("Users can log in.");
    expect(body).toContain("B");        // a member with no outcome is still listed
    expect(body).toContain("f1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/autopilot.test.ts -t buildFeaturePrBody`
Expected: FAIL

- [ ] **Step 3: Generalize `createTaskPr`**

Rename the function to `createBranchPr`, changing only the input names (`worktreePath` → `cwd`, `workBranch` → `branch`) — the body already uses `worktreePath` solely as the `cwd` of every `run()` call, so nothing else changes. Then:

```ts
/** A task's PR: the branch-level function with the task's worktree as cwd. */
export async function createTaskPr(input: {
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<CreatePrResult> {
  return createBranchPr({
    cwd: input.worktreePath,
    branch: input.workBranch,
    baseBranch: input.baseBranch,
    title: input.title,
    body: input.body,
  });
}

/**
 * A feature's PR body: the approved spec, then every member's self-reported
 * outcome line. Nothing new is generated — the feature-layer design already
 * established that a feature's business summary IS its members' outcome lines
 * stacked, so generating a second summary here would be a thing to keep in sync.
 */
export function buildFeaturePrBody(input: {
  context: string;
  description: string;
  outcomes: { title: string; outcome: string }[];
  featureId: string;
}): string {
  const parts: string[] = [];
  if (input.description?.trim()) parts.push(input.description.trim());
  if (input.context?.trim()) parts.push(`## Spec\n\n${input.context.trim()}`);
  if (input.outcomes.length)
    parts.push(
      `## What landed\n\n` +
        input.outcomes.map((o) => `- **${o.title}** — ${o.outcome?.trim() || "_no outcome reported_"}`).join("\n")
    );
  parts.push(`---\n_Opened by Agent Orchestrator autopilot (feature ${input.featureId})._`);
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run tests/autopilot.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add lib/github.ts tests/autopilot.test.ts
git commit -m "refactor(github): split createBranchPr out of createTaskPr

Same split landBranch made out of mergeTask, for the same reason: a feature's
integration branch has no worktree, so the part that doesn't need one is
factored out rather than reimplemented alongside."
```

---

## Chunk 5: Routes and wiring

### Task 8: approve-plan, feature PR, PATCH autopilot

**Files:**
- Create: `app/api/features/[id]/approve-plan/route.ts`, `app/api/features/[id]/pr/route.ts`
- Modify: `app/api/features/[id]/route.ts`, `app/api/events/route.ts`, `app/api/recaps/sweep/route.ts`, `app/api/tasks/[id]/messages/route.ts`

- [ ] **Step 1: `approve-plan`**

```ts
import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, featureMembers, updateTask } from "@/lib/store";
import { createFeatureBranch } from "@/lib/git";
import { ensureAutopilot, sweep } from "@/lib/autopilot";
import { resolveFeatures } from "@/lib/features";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Gate 1 — the user approves the plan. Everything this does, the user could do
 * by hand: accept each suggestion, cut the branch, start the first task. It's
 * one button because doing it by hand twenty times is the thing being fixed.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!resolveFeatures().autopilot)
    return NextResponse.json({ error: "autopilot is not enabled on this instance (ORCH_FEATURE_AUTOPILOT=1)" }, { status: 400 });

  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });

  const members = featureMembers(id);
  if (!members.length) return NextResponse.json({ error: "this feature has no tasks to approve" }, { status: 400 });

  // Cut the integration branch if the feature doesn't have one. Autopilot merges
  // task branches into it unattended, so landing that work straight onto the
  // project branch — which is what an empty features.branch means — is not a
  // thing this button may do silently.
  let branch = feature.branch;
  if (!branch) {
    branch = `feature/${feature.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || id}`;
    const made = await createFeatureBranch(project.repo_path, branch, project.branch);
    if (!made) return NextResponse.json({ error: "could not create the integration branch (is this a git repo with a commit?)" }, { status: 400 });
    updateFeature(id, { branch, base_sha: made.sha });
  }

  let accepted = 0;
  for (const t of members) {
    if (!t.suggested) continue;
    updateTask(t.id, { suggested: 0 });
    accepted++;
  }
  updateFeature(id, { autopilot: 1 });
  track("autopilot_plan_approved", { feature_id: id, project_id: project.id, tasks: members.length });

  ensureAutopilot();
  void sweep(project.id).catch(() => {});

  return NextResponse.json({ ok: true, branch, accepted, total: members.length });
}
```

- [ ] **Step 2: The feature PR route**

```ts
import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, featureMembers } from "@/lib/store";
import { createBranchPr, buildFeaturePrBody } from "@/lib/github";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// Push the integration branch and open a PR against the project branch — gate 2.
// Autopilot calls the same code when the last member lands; this route is the
// manual equivalent, and re-running it re-pushes and returns the open PR.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch) return NextResponse.json({ error: "this feature has no integration branch" }, { status: 400 });

  const members = featureMembers(id);
  const res = await createBranchPr({
    cwd: project.repo_path,
    branch: feature.branch,
    baseBranch: project.branch,
    title: feature.name,
    body: buildFeaturePrBody({
      context: feature.context,
      description: feature.description,
      outcomes: members.filter((t) => t.status === "done").map((t) => ({ title: t.title, outcome: t.outcome })),
      featureId: id,
    }),
  });
  if (res.ok && res.url) updateFeature(id, { pr_url: res.url });
  return NextResponse.json(res, { status: res.ok ? 200 : 409 });
}
```

- [ ] **Step 3: PATCH accepts `autopilot`**

In `app/api/features/[id]/route.ts`, add `"autopilot"` to the whitelist array and extend the comment above it:

```ts
  // Whitelist. `branch`/`base_sha`/`merged_at`/`pr_url` are deliberately absent:
  // those are git state, owned by the /branch, /ship and /pr routes, which hold
  // the guards. `autopilot` IS here — it's the pause switch, and pausing must
  // never be harder than resuming.
  for (const k of ["description", "context", "color", "archived", "position", "autopilot"] as const) {
```

- [ ] **Step 4: Arm the controller from the always-open stream and the sweep**

`app/api/events/route.ts` — call `ensureAutopilot()` at the top of the GET handler.
`app/api/recaps/sweep/route.ts` — `void sweepAutopilot().catch(() => {})` alongside the recap sweep.

- [ ] **Step 5: A human message clears the block**

`app/api/tasks/[id]/messages/route.ts` — in the POST path, where the task row is settled before launching the turn, add `blocked_reason: "", gate_attempts: 0` to the `updateTask` patch. Answering a blocked task IS how it resumes; there is no separate resume affordance to forget about.

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; suite green.

- [ ] **Step 7: Commit**

```bash
git add app/api tests
git commit -m "feat(autopilot): approve-plan, feature PR, and the pause switch

approve-plan is gate 1: accept the suggestions, cut the integration branch,
arm the controller. Cutting the branch is not optional — an empty
features.branch means members merge onto the project branch, which is not
something this button may do unattended."
```

---

## Chunk 6: UI and docs

### Task 9: Feature page surface

**Files:**
- Modify: `app/orchestrator/FeatureLanding.tsx`, `app/orchestrator/types.ts`

- [ ] **Step 1: Extend the client types** — `autopilot`, `pr_url`, `blocked_count` on the feature type; `blocked_reason` on the task type.

- [ ] **Step 2: Add the surface**, gated on `clientFeatures().autopilot`:
  - **Approve plan** button when `autopilot === 0` and the feature has members — confirms how many tasks will start and on which branch.
  - **Autopilot running** state with a **Pause** button (`PATCH { autopilot: 0 }`) when on.
  - **Review PR** link when `pr_url` is set.
  - Each member's `blocked_reason` rendered under its row, since that's the thing the user is being asked to act on.

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, open a project with a feature, confirm the button appears only with `ORCH_FEATURE_AUTOPILOT=1` and that pausing round-trips.

- [ ] **Step 4: Commit**

### Task 10: Documentation

**Files:**
- Modify: `.env.example`, `README.md`, `CLAUDE.md`

- [ ] **Step 1:** `.env.example` — document `ORCH_FEATURE_AUTOPILOT`, `ORCH_FEATURE_AUTOPILOT_SHADOW`, `ORCH_AUTOPILOT_CONCURRENCY`, `ORCH_AUTOPILOT_ATTEMPTS`, `ORCH_GATE_TEST_TIMEOUT_MS`.
- [ ] **Step 2:** `README.md` — an Autopilot section: the two gates, the loop, shadow mode, and that it is off by default.
- [ ] **Step 3:** `CLAUDE.md` — a subsection under the feature layer covering `lib/autopilot.ts` (event-driven, idempotent, serialized), `lib/gates.ts` (why the test runs in the worktree and not through services.ts), and that escalation reuses the durable-notice pattern.
- [ ] **Step 4: Commit**

---

## Verification

Before claiming done:

```bash
npx tsc --noEmit          # strict, no errors
npm test                  # full suite, serial
```

Then a real run with `ORCH_FEATURE_AUTOPILOT=1 ORCH_FEATURE_AUTOPILOT_SHADOW=1`: plan a two-task feature in a scratch project, approve it, and confirm both tasks run, gate, and stop at the shadow-mode hand-back without merging.
