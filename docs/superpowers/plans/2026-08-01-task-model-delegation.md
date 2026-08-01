# Task Model Delegation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a planning agent assign a model and reasoning preset to each task it suggests, and let a human see and change that choice before the task runs.

**Architecture:** `tasks.model` / `tasks.reasoning` already exist and are already honoured by both drivers — nothing about how a turn runs changes. This adds three things around them: a `tier` field on the capability descriptor, a generated menu + routing rubric injected into `buildProjectContext()` (one place, both agents), and two new `suggest_task` parameters validated server-side in `createSuggestedTask()`. The UI half puts model/reasoning selects in the new/edit task modals and a model badge on task cards.

**Tech Stack:** Next.js 15 (App Router) · TypeScript strict · better-sqlite3 · vitest · zod · `@modelcontextprotocol/sdk` · `@anthropic-ai/claude-agent-sdk`

**Spec:** `docs/superpowers/specs/2026-08-01-task-model-delegation-design.md`

**Branch:** `task-model-delegation`

---

## Orientation for the implementer

Things about this codebase that will bite you if you don't know them:

- **`npm test` is vitest, serial on purpose** (tests spawn real git subprocesses). A single file is `npx vitest run tests/agentTools.test.ts`. Tests are hermetic — `tests/setup.ts` points the DB and worktree dirs at tmp dirs *before the module graph loads*.
- **Never import `lib/agents/registry.ts` from a low-level module.** The agent SDKs are `serverExternalPackages`, which Turbopack emits as *async* externals, and async-ness propagates to every transitive importer — a module compiled async but imported from a sync route entry reads back `undefined` for every export at runtime. `lib/agents/capabilities.ts` exists as the SDK-free way to read capability data. `tests/importGraph.test.ts` enforces this. Every new capability read in this plan goes through `capabilities.ts`.
- **`lib/agentToolDefs.mjs` is plain `.mjs` holding literal data only** — no zod, no TS types. It is imported both through Next's bundler (the Claude driver) and by raw Node ESM (`scripts/orch-mcp.mjs`). Both consumers build their own zod schemas from the same strings, which is the only thing keeping them from drifting.
- **Two `suggest_task` call paths exist and both must be changed.** The Claude driver mounts an in-process SDK MCP server; every other agent goes through the stdio bridge → `POST /api/internal/agent-tools/suggest-task`. Both land in the same `createSuggestedTask()`.
- **`AgentBadge` returns `null` when `multi` is false.** You cannot hang the model badge inside it — a single-agent install would lose the badge entirely.
- **There is no `select` styling in `app/globals.css`.** Task 7 adds it. Don't skip that step and assume the control inherits something.
- **Commits explain the why.** Keep `README.md` current when behaviour changes. Markdown tables use minimal separators (`|-|-|`).

---

## File structure

| File | Responsibility after this change |
|-|-|
| `lib/agents/types.ts` | Adds `ModelTier` and `AgentModelOption.tier` |
| `lib/agents/claude/capabilities.ts` | Declares which four Claude models are delegation targets |
| `lib/agents/codex/capabilities.ts` | Same for Codex's two |
| `lib/agents/shared.ts` | Owns `buildDelegationGuidance()` — generates the menu + rubric from a descriptor — and calls it from `buildProjectContext()` |
| `lib/agentToolDefs.mjs` | The two new param descriptions, shared by both MCP consumers |
| `lib/agentTools.ts` | Validates model/reasoning against the descriptor; degrades unknown values with a note |
| `lib/store.ts` | `createTask` persists the two columns |
| `lib/agents/claude/driver.ts`, `scripts/orch-mcp.mjs`, `app/api/internal/agent-tools/suggest-task/route.ts` | Plumb the two params through both call paths |
| `app/api/tasks/route.ts` | Accepts them on manual creation |
| `app/orchestrator/modals.tsx` | `RunSelect` + both modals |
| `app/orchestrator/TaskBoard.tsx`, `app/orchestrator/TasksColumn.tsx` | Model badge on the card (two card components, one per view) |
| `app/globals.css` | `.field select` styling |
| `tests/delegation.test.ts` | New — tier uniqueness + guidance generation |

---

## Chunk 1: Capability tiers and the generated guidance

### Task 1: Add the `tier` field and declare it per agent

**Files:**
- Modify: `lib/agents/types.ts:13-25`
- Modify: `lib/agents/claude/capabilities.ts:27-42`
- Modify: `lib/agents/codex/capabilities.ts:14-17`
- Modify: `app/orchestrator/types.ts:192`
- Test: `tests/delegation.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/delegation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";

// buildDelegationGuidance assumes at most one model per tier — a second one
// would be silently dropped from the menu, so the descriptors are pinned here
// rather than the generator defensively picking a winner.
describe("model tiers", () => {
  for (const [name, caps] of [["claude", CLAUDE_CAPABILITIES], ["codex", CODEX_CAPABILITIES]] as const) {
    it(`${name} declares each tier at most once`, () => {
      const tiers = caps.models.map((m) => m.tier).filter(Boolean);
      expect(tiers.length).toBe(new Set(tiers).size);
    });

    it(`${name} declares at least one tiered model`, () => {
      expect(caps.models.some((m) => m.tier)).toBe(true);
    });
  }

  it("leaves Claude's pinned and 1M variants untiered — the planner is offered only current families", () => {
    const tiered = CLAUDE_CAPABILITIES.models.filter((m) => m.tier).map((m) => m.value);
    expect(tiered).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/delegation.test.ts`
Expected: FAIL — `declares at least one tiered model` fails (`false !== true`), and the Claude assertion returns `[]`. Type errors on `.tier` are also expected at this point.

- [ ] **Step 3: Add the type**

In `lib/agents/types.ts`, above `AgentModelOption`:

```ts
/**
 * Delegation tier — the class of work a model is the right pick for. Read only
 * by buildDelegationGuidance() in lib/agents/shared.ts, which generates the
 * suggest_task routing menu from these.
 */
export type ModelTier = "light" | "standard" | "heavy" | "max";
```

Then add the field to `AgentModelOption`, after `group`:

```ts
  /**
   * Marks this model as a delegation target and says what for. Untiered options
   * stay picker-only: a human may pin "Opus 4.6 · legacy" from the session
   * toolbar, but a planning agent is never offered it. At most one model per
   * tier per agent — pinned by tests/delegation.test.ts.
   */
  tier?: ModelTier;
```

- [ ] **Step 4: Declare the Claude tiers**

In `lib/agents/claude/capabilities.ts`, add `tier` to exactly four entries — leave every `[1m]` variant and pinned version untouched:

```ts
    { value: "fable", label: "Fable 5", sub: "most capable · 1M context", contextWindow: M1, group: "Latest", tier: "max" },
    { value: "opus", label: "Opus 5", sub: "everyday complex work", contextWindow: K200, group: "Latest", tier: "heavy" },
    { value: "sonnet", label: "Sonnet 5", sub: "efficient for routine tasks", contextWindow: K200, group: "Latest", tier: "standard" },
    { value: "haiku", label: "Haiku 4.5", sub: "fastest, lowest cost", contextWindow: K200, group: "Latest", tier: "light" },
```

Add above the `models` array, after the existing `contextWindow` comment block:

```ts
// `tier` marks a model as a suggest_task delegation target (see
// buildDelegationGuidance in lib/agents/shared.ts). Only the four current
// families carry one: offering a planner a pinned legacy version invites it to
// route real work there because the label sounded capable.
//
// ponytail: one model per tier, so heavy work on a very large codebase routes to
// `fable` rather than `opus[1m]` — the 1M variants are untiered. Widen tier to a
// list, with window size as a secondary axis, if that costs more than it saves.
```

- [ ] **Step 5: Declare the Codex tiers**

In `lib/agents/codex/capabilities.ts`:

```ts
  models: [
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", sub: "most capable", contextWindow: CTX, tier: "heavy" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", sub: "faster, cheaper", contextWindow: CTX, tier: "light" },
  ],
```

Note `max` is tier `heavy`, not `max`. Codex has two models, so the sparse-tier fold in Task 2 collapses standard + heavy + max onto it. Tiering it `max` would leave "ordinary feature work" folding oddly and reads wrong in the descriptor.

- [ ] **Step 6: Mirror the field client-side**

`app/orchestrator/types.ts:192` declares itself a mirror of `lib/agents/types.ts`. Keep it honest:

```ts
export interface AgentModelOption { value: string; label: string; sub: string; contextWindow: number; group?: string; tier?: "light" | "standard" | "heavy" | "max" }
```

The client does not read `tier` — the rubric is server-side. It is here so the next person diffing the two interfaces doesn't find a phantom drift.

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/delegation.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/agents/types.ts lib/agents/claude/capabilities.ts lib/agents/codex/capabilities.ts app/orchestrator/types.ts tests/delegation.test.ts
git commit -s -m "Mark which models are delegation targets, and for what

A planning agent about to assign a model per task needs a menu, and the
picker list is the wrong menu: it carries pinned legacy versions that
exist so a human can reproduce an old run, not so a planner can route new
work to Opus 4.6 because the label read as capable.

tier does double duty. It selects which models are offered, and it is
what lets the routing rubric be GENERATED rather than written as prose
naming models — prose keeps recommending haiku after haiku leaves the
picker, and fails without an error."
```

---

### Task 2: Generate the menu and rubric into the project context

**Files:**
- Modify: `lib/agents/shared.ts:1-9` (imports), `:34-42` (the suggest_task paragraph)
- Test: `tests/delegation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/delegation.test.ts`:

```ts
import { buildDelegationGuidance } from "@/lib/agents/shared";
import type { AgentCapabilities } from "@/lib/agents/types";

describe("buildDelegationGuidance", () => {
  it("lists Claude's four tiers cheapest-first with a work description each", () => {
    const g = buildDelegationGuidance(CLAUDE_CAPABILITIES);
    expect(g).toContain("`haiku`");
    expect(g).toContain("`fable`");
    // Untiered options never appear.
    expect(g).not.toContain("opus[1m]");
    expect(g).not.toContain("claude-opus-4-6");
    // Cheapest first, so a skimming planner meets the cheap option before the
    // expensive one.
    expect(g.indexOf("`haiku`")).toBeLessThan(g.indexOf("`fable`"));
  });

  it("gives a two-tier agent a destination for all four categories of work", () => {
    const g = buildDelegationGuidance(CODEX_CAPABILITIES);
    expect(g).toContain("gpt-5.1-codex-mini");
    expect(g).toContain("gpt-5.1-codex-max");
    // standard + heavy + max all fold onto the top model present.
    const maxLine = g.split("\n").find((l) => l.includes("gpt-5.1-codex-max"))!;
    expect(maxLine).toContain("ordinary feature work");
    expect(maxLine).toContain("multi-file refactors");
    expect(maxLine).toContain("whole-codebase reasoning");
  });

  it("names the lowest and highest reasoning presets", () => {
    const g = buildDelegationGuidance(CLAUDE_CAPABILITIES);
    expect(g).toContain("`off`");
    expect(g).toContain("`ultrathink`");
  });

  it("returns empty for an agent with no tiered models, so the tool reads as it did before", () => {
    const caps = { ...CLAUDE_CAPABILITIES, models: CLAUDE_CAPABILITIES.models.map(({ tier, ...m }) => m) } as AgentCapabilities;
    expect(buildDelegationGuidance(caps)).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/delegation.test.ts`
Expected: FAIL — `buildDelegationGuidance` is not exported from `lib/agents/shared`.

- [ ] **Step 3: Write the generator**

In `lib/agents/shared.ts`, extend the imports:

```ts
import type { Project, Task, AskQuestion, AskAnswers, ToolPeek, DiffLine } from "../types";
import type { AgentCapabilities, AgentModelOption, ModelTier } from "./types";
import { getCapabilities } from "./capabilities";
import { listSummaries } from "../store";
```

`getCapabilities` comes from `capabilities.ts`, never `registry.ts` — see the header of that file and `tests/importGraph.test.ts`.

Add above `buildProjectContext`:

```ts
// ---------- suggest_task delegation guidance ----------
//
// Which model a PROPOSED task should run on. Both the menu and the rubric are
// generated from the agent's capability descriptor (models[].tier) instead of
// written as prose naming models: prose would go on recommending a model after
// it left the picker, and would do so silently.

const TIER_ORDER: ModelTier[] = ["light", "standard", "heavy", "max"];

const TIER_WORK: Record<ModelTier, string> = {
  light: "mechanical, well-scoped edits; docs; renames; test scaffolding; anything with a clear recipe",
  standard: "ordinary feature work in a familiar codebase; straightforward bugfixes",
  heavy: "multi-file refactors, tricky debugging, design and architecture calls, security-sensitive work",
  max: "whole-codebase reasoning, novel architecture, or work that needs the largest context window",
};

/**
 * The model/reasoning paragraph appended to the suggest_task instructions, or
 * "" when the agent declares no tiered models — in which case the tool reads
 * exactly as it did before this feature.
 *
 * Sparse tiers fold rather than leaving a gap: each tier's work description
 * attaches to the lowest PRESENT tier at or above it, and anything above the
 * highest present tier attaches to that highest tier. Codex ships two models
 * and still gives all four categories of work somewhere to go.
 */
export function buildDelegationGuidance(caps: AgentCapabilities): string {
  const tiered = new Map<ModelTier, AgentModelOption>();
  for (const m of caps.models) if (m.tier && !tiered.has(m.tier)) tiered.set(m.tier, m);
  if (tiered.size === 0) return "";

  const work = new Map<string, string[]>();
  const attach = (value: string, descriptions: string[]) => work.set(value, [...(work.get(value) ?? []), ...descriptions]);
  let pending: string[] = [];
  for (const tier of TIER_ORDER) {
    pending.push(TIER_WORK[tier]);
    const m = tiered.get(tier);
    if (!m) continue;
    attach(m.value, pending);
    pending = [];
  }
  if (pending.length) {
    const top = [...TIER_ORDER].reverse().find((t) => tiered.has(t))!;
    attach(tiered.get(top)!.value, pending);
  }

  const lines = [
    `\nWhen you suggest a task, also choose the model it should run on and pass it as \`model\`, ` +
      `so routine work doesn't run on an expensive model and hard work doesn't fail on a cheap one. ` +
      `The options for this project, cheapest first:`,
  ];
  for (const tier of TIER_ORDER) {
    const m = tiered.get(tier);
    if (m) lines.push(`- \`${m.value}\` (${m.label} — ${m.sub}): ${work.get(m.value)!.join("; ")}`);
  }

  // reasoningOptions runs lowest → highest intensity in every descriptor. The
  // first/last picks below depend on that ordering and nothing in the type
  // enforces it, so a new driver that lists them out of order breaks this line.
  const presets = caps.reasoningOptions;
  if (presets.length > 1) {
    const lo = presets[0].value;
    const hi = presets[presets.length - 1].value;
    lines.push(
      `\nYou may also pass \`reasoning\`, one of: ${presets.map((r) => `\`${r.value}\``).join(", ")}. ` +
        `Use \`${lo}\` for mechanical work, and reserve \`${hi}\` for the single hardest task in the plan.`
    );
  }
  lines.push(`Omit either parameter to inherit the project's default.`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Call it from `buildProjectContext`**

In `buildProjectContext`, directly after the existing `lines.push()` that describes `suggest_task` (the one ending `propose it with \`suggest_task\` instead.`):

```ts
  // Model/reasoning routing for the tasks it proposes. Built from the agent the
  // SUGGESTED task will run under — suggest_task sets no agent, so createTask
  // falls back to projects.default_agent (lib/store.ts) — NOT from the planner's
  // own task.agent, which would offer Claude values to a plan destined for Codex.
  const delegation = buildDelegationGuidance(getCapabilities(project.default_agent));
  if (delegation) lines.push(delegation);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/delegation.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Prove the import-graph rule still holds**

Run: `npx vitest run tests/importGraph.test.ts`
Expected: PASS. If it fails, you imported `getCapabilities` from `registry.ts` — change it to `./capabilities`.

- [ ] **Step 7: Eyeball the generated prompt once**

Run:

```bash
npx tsx -e "import('./lib/agents/shared').then(async m => { const c = await import('./lib/agents/claude/capabilities'); console.log(m.buildDelegationGuidance(c.CLAUDE_CAPABILITIES)); })" 2>/dev/null \
  || npx vitest run tests/delegation.test.ts --reporter=verbose
```

This is prompt text a model has to act on — read it once and check it scans as instructions rather than as a data dump. Fix the wording now if it doesn't; it is far cheaper than diagnosing bad routing later.

- [ ] **Step 8: Commit**

```bash
git add lib/agents/shared.ts tests/delegation.test.ts
git commit -s -m "Tell the planner which model to use, and what each is for

buildProjectContext is the one place both drivers already reach for the
suggest_task instructions, so the menu and rubric go there and Codex gets
them without the stdio bridge learning anything.

The menu is built from the agent the SUGGESTED task will run under, not
the planner's own — suggest_task sets no agent, so createTask falls back
to projects.default_agent, and reading task.agent would offer Claude
values to a plan that will run on Codex.

Sparse tiers fold instead of leaving a gap: Codex declares two models and
all four categories of work still have a destination."
```

---

## Chunk 2: Persistence, validation, and both tool call paths

### Task 3: `createTask` persists model and reasoning

**Files:**
- Modify: `lib/store.ts:294-318`
- Test: `tests/delegation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/delegation.test.ts`:

```ts
import { createProject, createTask, getTask } from "@/lib/store";

describe("createTask run config", () => {
  it("persists model and reasoning when given", () => {
    const p = createProject({ name: "Store" });
    const t = createTask({ project_id: p.id, title: "T", model: "haiku", reasoning: "off" });
    expect(getTask(t.id)).toMatchObject({ model: "haiku", reasoning: "off" });
  });

  it("defaults both to null — inherit the agent default", () => {
    const p = createProject({ name: "Store2" });
    const t = createTask({ project_id: p.id, title: "T" });
    expect(getTask(t.id)).toMatchObject({ model: null, reasoning: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/delegation.test.ts -t "createTask run config"`
Expected: FAIL — `model`/`reasoning` are not valid `createTask` inputs (TS error), and the first assertion gets `null`.

- [ ] **Step 3: Widen the signature and the INSERT**

In `lib/store.ts`, extend the input type:

```ts
export function createTask(input: {
  project_id: string;
  title: string;
  description?: string;
  priority?: Priority;
  suggested?: boolean;
  agent?: string;
  // Run config. null/absent = inherit (app default, then the driver's own).
  // Callers are responsible for validating these against the agent's
  // capability descriptor — see validateRun() in lib/agentTools.ts.
  model?: string | null;
  reasoning?: string | null;
}): Task {
```

and the statement:

```ts
  getDb()
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, priority, status, suggested, agent, model, reasoning, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.project_id, input.title, input.description ?? "", input.priority ?? "med", input.suggested ? 1 : 0, agent, input.model ?? null, input.reasoning ?? null, position, now, now);
```

Count the placeholders against the column list before you run it — this statement is positional and a miscount inserts the position integer into `reasoning`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/delegation.test.ts -t "createTask run config"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts tests/delegation.test.ts
git commit -s -m "Let a task be born with a model, not just given one later

tasks.model and tasks.reasoning have always existed and updateTask has
always written them; createTask just never did, so every task started as
null and could only be retargeted after the fact. No migration — the
columns are already there."
```

---

### Task 4: Validate the two params and degrade unknown values with a note

**Files:**
- Modify: `lib/agentToolDefs.mjs:16-32`
- Modify: `lib/agentTools.ts:12-19` (imports), `:32-68`
- Test: `tests/agentTools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `describe("agentTools shared logic", …)` block in `tests/agentTools.test.ts`:

```ts
  it("persists a valid model and reasoning onto the suggested task", () => {
    const project = createProject({ name: "Run" });
    const { task, text } = createSuggestedTask(project, { title: "Fast one", description: "", model: "haiku", reasoning: "off" });
    expect(getTask(task.id)).toMatchObject({ model: "haiku", reasoning: "off" });
    // Nothing to correct, so no note.
    expect(text).not.toContain("isn't available");
  });

  it("accepts any model in the descriptor, including untiered pins", () => {
    const project = createProject({ name: "Pin" });
    const { task } = createSuggestedTask(project, { title: "Pinned", description: "", model: "claude-opus-4-8" });
    expect(getTask(task.id)!.model).toBe("claude-opus-4-8");
  });

  it("drops an unrecognised model to null and tells the agent so it self-corrects", () => {
    const project = createProject({ name: "Bogus" });
    const { task, text } = createSuggestedTask(project, { title: "Wrong", description: "", model: "gpt-5", reasoning: "galaxy-brain" });
    const row = getTask(task.id)!;
    expect(row.model).toBeNull();
    expect(row.reasoning).toBeNull();
    // The task is still created — a bad value must never cost the plan a task.
    expect(row.title).toBe("Wrong");
    expect(text).toContain('model "gpt-5" isn\'t available');
    expect(text).toContain('reasoning "galaxy-brain" isn\'t available');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/agentTools.test.ts`
Expected: FAIL — `model` is not a valid `SuggestTaskInput` property (TS error); the persisted rows are `null`.

- [ ] **Step 3: Add the param descriptions**

In `lib/agentToolDefs.mjs`, extend `SUGGEST_TASK`. Add to `params`:

```js
    model:
      "Which model this task should run on. Use one of the values listed in the delegation guidance in your project context — omit to inherit the project default.",
    reasoning:
      "Thinking budget for this task, one of the presets listed in your project context — omit to inherit the project default.",
```

and add one sentence to `description`, before the `blocked_by` sentence:

```js
    "Match the model to the work: your project context lists which models are available and what each one is for. " +
```

- [ ] **Step 4: Write the validator**

In `lib/agentTools.ts`, add the import:

```ts
import { getCapabilities } from "./agents/capabilities";
```

Extend `SuggestTaskInput`:

```ts
export interface SuggestTaskInput {
  title: string;
  description: string;
  priority?: Priority;
  /** Already resolved to task ids (see resolveTitleRefs) — id passes through to setTaskDeps. */
  blocked_by?: string[];
  /** Raw model / reasoning values from the agent — validated below, never trusted. */
  model?: string;
  reasoning?: string;
}
```

Add above `createSuggestedTask`:

```ts
/**
 * Check the run config an agent chose against the descriptor of the agent that
 * will actually run the task. This is a trust boundary: both values are free
 * text produced by a language model and land in a database write.
 *
 * An unrecognised value degrades to null (inherit) rather than throwing, and
 * comes back as a note appended to the text the agent receives — which is the
 * point. A planner that gets told its guess was wrong fixes the next of its
 * twenty calls; one that gets a silent null repeats the mistake all twenty times.
 *
 * Anything in the descriptor is accepted, including untiered options: `tier`
 * governs what the guidance OFFERS, not what the tool ALLOWS. Rejecting a
 * pinned model an agent named correctly would make the accepted set differ from
 * the human picker's for no benefit.
 */
function validateRun(agent: string | null | undefined, input: SuggestTaskInput): { model: string | null; reasoning: string | null; note: string } {
  const caps = getCapabilities(agent);
  const notes: string[] = [];
  const pick = (kind: string, raw: string | undefined, allowed: string[]): string | null => {
    if (!raw) return null;
    if (allowed.includes(raw)) return raw;
    notes.push(`${kind} "${raw}" isn't available for this project's agent — using the default.`);
    return null;
  };
  return {
    model: pick("model", input.model, caps.models.map((m) => m.value)),
    reasoning: pick("reasoning", input.reasoning, caps.reasoningOptions.map((r) => r.value)),
    note: notes.length ? ` (${notes.join(" ")})` : "",
  };
}
```

- [ ] **Step 5: Use it in `createSuggestedTask`**

```ts
export function createSuggestedTask(project: Project, input: SuggestTaskInput): { task: Task; text: string } {
  // The task's agent is projects.default_agent (suggest_task never sets one, so
  // createTask falls back to it) — validate against that agent's descriptor.
  const run = validateRun(project.default_agent, input);
  const task = createTask({
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
    model: run.model,
    reasoning: run.reasoning,
  });
```

and extend the returned text:

```ts
  return {
    task,
    text: `Suggested task "${input.title}" added to the project tray (id: ${task.id}).${depNote}${run.note}`,
  };
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/agentTools.test.ts`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 7: Commit**

```bash
git add lib/agentToolDefs.mjs lib/agentTools.ts tests/agentTools.test.ts
git commit -s -m "Take a model from suggest_task, and don't trust it

Both values are free text from a language model landing in a database
write, so nothing reaches createTask without matching the descriptor of
the agent that will run the task.

An unknown value degrades to the default and returns a note rather than
throwing. The note is the useful half: a planner told its guess was wrong
fixes the next of its twenty calls, where a silent null repeats the
mistake twenty times. Same degrade-with-a-note shape as blocked_by.

Untiered options are accepted. tier governs what the guidance offers, not
what the tool allows — a correctly-named pinned model isn't an error, and
rejecting it would make the accepted set differ from the picker's."
```

---

### Task 5: Plumb both MCP call paths

**Files:**
- Modify: `lib/agents/claude/driver.ts:60-82`
- Modify: `scripts/orch-mcp.mjs:77-97`
- Modify: `app/api/internal/agent-tools/suggest-task/route.ts:14-38`
- Test: `tests/orchMcp.test.ts`, `tests/agentTools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/orchMcp.test.ts`, add to the `describe("orch-mcp stdio bridge", …)` block:

```ts
  it("forwards model and reasoning to the internal endpoint", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Cheap", description: "rename a thing", model: "haiku", reasoning: "off" },
      });
      const call = calls.find((c) => c.body.title === "Cheap")!;
      expect(call.body).toMatchObject({ model: "haiku", reasoning: "off" });
    } finally {
      await close();
    }
  });
```

In `tests/agentTools.test.ts`, add to the `describe("internal agent-tool endpoints", …)` block:

```ts
  it("suggest-task applies model and reasoning from the body", async () => {
    const project = createProject({ name: "EP-Run" });
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Routed",
      description: "",
      model: "sonnet",
      reasoning: "think",
    });
    const json = (await res.json()) as { id: string };
    expect(getTask(json.id)).toMatchObject({ model: "sonnet", reasoning: "think" });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/orchMcp.test.ts tests/agentTools.test.ts`
Expected: FAIL — the bridge drops the two arguments (`body` has no `model`), and the endpoint never forwards them (`model` is `null`).

- [ ] **Step 3: The Claude driver**

In `lib/agents/claude/driver.ts`, extend the `suggest_task` schema:

```ts
          blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
          model: z.string().optional().describe(SUGGEST_TASK.params.model),
          reasoning: z.string().optional().describe(SUGGEST_TASK.params.reasoning),
```

`z.string()`, not `z.enum` — the stdio bridge is plain Node and cannot import the TypeScript descriptors, so an enum here would exist on one side only and the two schemas would drift. Validation is `validateRun()`, which both paths share.

Extend the handler's arg type and the call:

```ts
        async (args: { title: string; description: string; priority: "hi" | "med" | "lo"; blocked_by?: string[]; model?: string; reasoning?: string }) => {
          // Resolve refs (id passes through; a title from earlier this session maps
          // to its id) then create + wire deps via the shared logic. Record this
          // task's title→id so later suggestions can reference it by title.
          const { task, text } = createSuggestedTask(project, {
            title: args.title,
            description: args.description,
            priority: args.priority,
            blocked_by: resolveTitleRefs(args.blocked_by, createdByTitle),
            model: args.model,
            reasoning: args.reasoning,
          });
```

- [ ] **Step 4: The stdio bridge**

In `scripts/orch-mcp.mjs`, extend the `inputSchema`:

```js
      blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
      model: z.string().optional().describe(SUGGEST_TASK.params.model),
      reasoning: z.string().optional().describe(SUGGEST_TASK.params.reasoning),
```

and the handler:

```js
  async ({ title, description, priority, blocked_by, model, reasoning }) => {
    // Resolve refs (id passes through; a title from earlier this turn → its id)
    // before handing off — the endpoint just forwards ids to setTaskDeps.
    const deps = (blocked_by ?? []).map((ref) => createdByTitle.get(ref) ?? ref);
    const data = await callInternal("suggest-task", { title, description, priority, blocked_by: deps, model, reasoning });
```

- [ ] **Step 5: The internal endpoint**

In `app/api/internal/agent-tools/suggest-task/route.ts`, extend the body type:

```ts
    blocked_by?: string[];
    model?: string;
    reasoning?: string;
```

and the call:

```ts
  const { task, text } = createSuggestedTask(project, {
    title: body.title,
    description: body.description ?? "",
    priority: body.priority,
    blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : undefined,
    // Unvalidated on purpose — createSuggestedTask owns that, so both call
    // paths get identical treatment from one place.
    model: typeof body.model === "string" ? body.model : undefined,
    reasoning: typeof body.reasoning === "string" ? body.reasoning : undefined,
  });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/orchMcp.test.ts tests/agentTools.test.ts`
Expected: PASS. The bridge test spawns the real `scripts/orch-mcp.mjs`, so this is the step that catches the bridge half being forgotten.

- [ ] **Step 7: Full server-side test pass**

Run: `npm test`
Expected: PASS. Watch `tests/agentDriver.test.ts` and `tests/importGraph.test.ts` in particular.

- [ ] **Step 8: Commit**

```bash
git add lib/agents/claude/driver.ts scripts/orch-mcp.mjs app/api/internal/agent-tools/suggest-task/route.ts tests/orchMcp.test.ts tests/agentTools.test.ts
git commit -s -m "Carry model and reasoning down both suggest_task paths

Claude mounts the tool in-process; everything else reaches it through the
stdio bridge and the internal endpoint. Both are wired here, and the
bridge test spawns the real script — the only thing that catches half of
this being forgotten.

Both sides declare z.string(), not z.enum. The bridge is plain Node and
cannot import the TypeScript descriptors, so an enum would exist on one
side only and the schemas would drift, which is the exact failure
agentToolDefs.mjs was created to prevent. Values are enforced once, in
createSuggestedTask."
```

---

## Chunk 3: The human half

### Task 6: Manual creation accepts a model

**Files:**
- Modify: `app/api/tasks/route.ts:13-32`

- [ ] **Step 1: Pass the fields through**

In `app/api/tasks/route.ts`, inside the `createTask({…})` call:

```ts
    agent: typeof body.agent === "string" ? body.agent : undefined,
    // Run config from the New task modal. Unlike suggest_task these come from
    // a picker built off the same descriptor, so there is nothing to validate.
    model: typeof body.model === "string" ? body.model : null,
    reasoning: typeof body.reasoning === "string" ? body.reasoning : null,
```

- [ ] **Step 2: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add app/api/tasks/route.ts
git commit -s -m "Accept a model when a task is created by hand

The modal's pickers are built from the same capability descriptor the
server validates against, so unlike the suggest_task path there is nothing
here to check."
```

---

### Task 7: A reusable run-config select, and the New task modal

**Files:**
- Modify: `app/globals.css:1071-1074`, `:1330-1332`
- Modify: `app/orchestrator/modals.tsx:1-14` (imports), `:48-103` (`NewTaskModal`)
- Modify: `app/orchestrator/useOrchestrator.ts:431-440`

- [ ] **Step 1: Style the control**

There is no `select` rule in `app/globals.css` — the control will render unstyled if you skip this.

Extend the existing input rule at line 1071:

```css
.field input[type=text],.field input[type=number],.field textarea,.field select{
```

and the focus rule at line 1088:

```css
.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
```

and the mobile 16px rule at line 1330 (below 16px, iOS zooms the page on focus):

```css
  .app.mobile .field input[type=text],
  .app.mobile .field input[type=number],
  .app.mobile .field select,
  .app.mobile .field textarea{font-size:16px;}
```

- [ ] **Step 2: Add `RunSelect`**

In `app/orchestrator/modals.tsx`, extend the imports:

```tsx
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SLABEL, modelOptions, reasoningOptions, type ProjectRow, type ProjectSession, type TaskRow, type AgentsBundle, type PickerOption } from "./types";
import { agentLabel, capsFor, defaultAgentFor, findAgent } from "./agents";
```

Add below `AgentPicker`:

```tsx
// Model / reasoning picker for the task modals. A native <select> rather than
// SessionView's Popover: the Claude list runs to fourteen options across three
// groups, and the native control brings keyboard navigation, type-ahead, scroll
// containment and screen-reader semantics with no code to maintain. `value:
// null` is the synthetic "Default" head — inherit the agent's default.
export function RunSelect({ label, options, value, onChange }: {
  label: string; options: PickerOption[]; value: string | null; onChange: (v: string | null) => void;
}) {
  // Consecutive options sharing a group render under one <optgroup>, mirroring
  // how the session toolbar sections the same list.
  const groups: { group?: string; opts: PickerOption[] }[] = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last && last.group === o.group) last.opts.push(o);
    else groups.push({ group: o.group, opts: [o] });
  }
  const sel = options.find((o) => o.value === value);
  return (
    <div className="field">
      <div className="lab">{label}</div>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        {groups.map((g, i) => (
          <Fragment key={i}>
            {g.group ? (
              <optgroup label={g.group}>
                {g.opts.map((o) => <option key={o.label} value={o.value ?? ""}>{o.label}</option>)}
              </optgroup>
            ) : (
              g.opts.map((o) => <option key={o.label} value={o.value ?? ""}>{o.label}</option>)
            )}
          </Fragment>
        ))}
      </select>
      {sel?.sub && <div className="hlp">{sel.sub}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `NewTaskModal`**

Extend the props type's `onCreate`:

```tsx
onCreate: (i: { title: string; desc: string; priority: Priority; agent: string; model: string | null; reasoning: string | null; startNow: boolean; depends_on: string[] }) => void;
```

Add state beside the existing `agent` state:

```tsx
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);
```

The options follow the selected agent, so a model chosen for Claude can't survive a switch to Codex:

```tsx
  const caps = capsFor(agents, agent);
  const pickAgent = (id: string) => { touched.current = true; setAgent(id); setModel(null); setReasoning(null); };
```

Extend `create`:

```tsx
  const create = () => can && onCreate({ title: title.trim(), desc: desc.trim(), priority, agent, model, reasoning, startNow: startNow && canStart, depends_on: deps });
```

and add the two fields directly below `<AgentPicker …/>`:

```tsx
      <RunSelect label="Model" options={modelOptions(caps)} value={model} onChange={setModel} />
      <RunSelect label="Reasoning" options={reasoningOptions(caps)} value={reasoning} onChange={setReasoning} />
```

- [ ] **Step 4: Send them from the hook**

In `app/orchestrator/useOrchestrator.ts`, widen `createTask`'s input and body:

```ts
  const createTask = async (input: { title: string; desc: string; priority: Priority; agent: string; model: string | null; reasoning: string | null; startNow: boolean; depends_on: string[] }) => {
    if (!project) return;
    const t = await jsend<TaskRow>("/api/tasks", "POST", { project_id: project.id, title: input.title, description: input.desc, priority: input.priority, agent: input.agent, model: input.model, reasoning: input.reasoning });
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Check it in the browser**

Start the app (`npm run dev`, or rebuild the container per `docs/SELF_HOSTING.md` if that's your setup), open a project, click New task. Verify: both selects render inside the form box like the text inputs, the Claude model list shows its three group headers, the sub-line under each updates on change, and switching agent resets both to Default.

- [ ] **Step 7: Commit**

```bash
git add app/globals.css app/orchestrator/modals.tsx app/orchestrator/useOrchestrator.ts
git commit -s -m "Pick a model when creating a task, not only after starting it

A native <select> rather than the session toolbar's Popover: fourteen
options across three groups, and the native control brings keyboard
navigation, type-ahead, scroll containment and screen-reader semantics
for free. Needed a .field select rule — there was no select anywhere in
the app until now.

Switching agent clears both, since the options come from that agent's
descriptor and a Claude model value means nothing to Codex."
```

---

### Task 8: Override a suggestion before it runs

**Files:**
- Modify: `app/orchestrator/modals.tsx` (`EditTaskModal`)
- Modify: `app/Orchestrator.tsx:545`
- Modify: `app/orchestrator/useOrchestrator.ts:469-473`

This is the task that makes the whole feature safe to use: `EditTaskModal` is what a suggested-task card opens, so it is the only place a planner's choice can be corrected before the task spends a turn.

- [ ] **Step 1: Extend the modal**

Props gain `agents`, and `onSave`'s patch gains the two fields:

```tsx
export function EditTaskModal({ task, tasks, agents, onClose, onSave, onDelete }: {
  task: TaskRow; tasks: TaskRow[]; agents: AgentsBundle; onClose: () => void;
  onSave: (id: string, patch: { title: string; description: string; priority: Priority; model: string | null; reasoning: string | null; depends_on: string[] }) => void;
  onDelete: (id: string) => void;
}) {
```

Add state and capabilities beside the existing state:

```tsx
  const [model, setModel] = useState<string | null>(task.model);
  const [reasoning, setReasoning] = useState<string | null>(task.reasoning);
  // A task's agent is fixed at creation, so the options never change under us.
  const caps = capsFor(agents, task.agent);
```

Extend `save`:

```tsx
  const save = () => can && onSave(task.id, { title: title.trim(), description: desc.trim(), priority, model, reasoning, depends_on: deps });
```

Add the two fields between the Priority field and `<DepPicker …/>`:

```tsx
      <RunSelect label="Model" options={modelOptions(caps)} value={model} onChange={setModel} />
      <RunSelect label="Reasoning" options={reasoningOptions(caps)} value={reasoning} onChange={setReasoning} />
```

- [ ] **Step 2: Pass the bundle in**

`app/Orchestrator.tsx:545`:

```tsx
        <EditTaskModal task={o.tasks.find((t) => t.id === o.editId)!} tasks={o.realTasks} agents={o.agents} onClose={() => o.setEditId(null)} onSave={o.saveTask} onDelete={o.removeTask} />
```

- [ ] **Step 3: Widen the save handler**

`app/orchestrator/useOrchestrator.ts:469`:

```ts
  const saveTask = async (id: string, patch: { title: string; description: string; priority: Priority; model: string | null; reasoning: string | null; depends_on: string[] }) => {
```

The body is unchanged — it already PATCHes the whole patch object, and `PATCH /api/tasks/[id]` already whitelists `model` and `reasoning` (`app/api/tasks/[id]/route.ts:32`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify the round trip in the browser**

Open a suggested task's card, change Model to something other than Default, save, reopen. The new value is selected. Confirm in the DB if you want certainty:

```bash
sqlite3 ~/.zen-orchestrator/orchestrator.db "SELECT title, model, reasoning FROM tasks ORDER BY updated_at DESC LIMIT 5;"
```

- [ ] **Step 6: Commit**

```bash
git add app/orchestrator/modals.tsx app/Orchestrator.tsx app/orchestrator/useOrchestrator.ts
git commit -s -m "Let a suggested task's model be changed before it runs

A suggested card opens EditTaskModal, not the session view, and the only
model picker lived in the session toolbar — reachable after the task had
already started. Correcting a planner's choice therefore cost the turn the
choice was meant to save.

EditTaskModal gains the agents bundle so its options come from the task's
own agent. PATCH already whitelisted both fields."
```

---

### Task 9: Show the assignment on the card

**Files:**
- Modify: `app/orchestrator/TaskBoard.tsx:6-8` (imports), `:128-131`
- Modify: `app/orchestrator/TasksColumn.tsx:5-7` (imports), `:26-31`

Two card components — the board view and the list view. Both need it; the list is the default.

Both files currently import `{ isAwaiting, relTime }` from `./format` and
`{ agentLabel }` from `./agents`. Both need `modelLabel` and `capsFor` added:

```tsx
import { isAwaiting, modelLabel, relTime } from "./format";
import { agentLabel, capsFor } from "./agents";
```

`.model-badge` already exists in `app/globals.css:747` (the session toolbar uses
it) and needs no new CSS.

- [ ] **Step 1: Board card**

In `app/orchestrator/TaskBoard.tsx`, in `BoardCard`'s `bc-meta` row, after
`<AgentBadge …/>`:

```tsx
        {task.model && <span className="model-badge" title={`Runs on ${modelLabel(task.model, capsFor(agents, task.agent))}`}>{modelLabel(task.model, capsFor(agents, task.agent))}</span>}
```

A separate span, not a prop on `AgentBadge` — that component returns `null` when
only one agent is registered, which would hide the model badge on every
single-agent install.

- [ ] **Step 2: List card**

`app/orchestrator/TasksColumn.tsx`'s `TaskCard` puts its `AgentBadge` in the
`.task-top` row (line 29), alongside the title, status label and priority pill.
Add the same span directly after it. That row is tighter than the board's
`bc-meta`, so check a long model label on a narrow column before moving on — if
it crowds, drop it below into the card body rather than shrinking the title.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Check both views**

Set a model on one task and leave another on Default. In both the list and board views the first shows a badge and the second shows none. Confirm the badge doesn't wrap the meta row at a narrow width.

- [ ] **Step 5: Commit**

```bash
git add app/orchestrator/TaskBoard.tsx app/orchestrator/TasksColumn.tsx
git commit -s -m "Badge the assigned model on task cards

Without it a planner's routing is invisible until something is opened, and
an invisible assignment is one nobody will trust or check. Its own span
rather than a prop on AgentBadge, which renders null on single-agent
installs and would take the model badge down with it."
```

---

### Task 10: Documentation and the full check

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README**

Find the `suggest_task` description and document the two new parameters and the behaviour: a planning agent picks a model and reasoning preset per task from the models its agent declares as delegation targets; unknown values fall back to the project default; the choice is visible on the task card and editable in the task modal before the task runs.

- [ ] **Step 2: CLAUDE.md**

The "Adding a third agent" paragraph is the one someone reads before writing a driver, and `tier` is a new rule for them. Add to that section:

> A driver's model options may carry a `tier` (`light`/`standard`/`heavy`/`max`) marking them as `suggest_task` delegation targets; `buildDelegationGuidance()` generates the planner's menu and routing rubric from those. Ship no tiers and the driver simply opts out — the tool behaves as it did before per-task delegation existed.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS, no skips introduced.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: succeeds. This is what catches a Turbopack async-external regression that `tsc` and vitest both miss.

- [ ] **Step 5: End-to-end check — the actual feature**

The unit tests prove the plumbing; this proves the prompt works, which is the part no test can assert. In a real project, start a task on a capable model and ask it to break the project into tasks. Then:

```bash
sqlite3 ~/.zen-orchestrator/orchestrator.db "SELECT title, model, reasoning FROM tasks WHERE suggested = 1 ORDER BY created_at DESC LIMIT 20;"
```

You are looking for **variation**. Every row on the same model means the rubric isn't landing — the fix is wording in `TIER_WORK` / the intro line in `buildDelegationGuidance`, not more code. Read the transcript's `suggest_task` calls to see what it actually passed.

- [ ] **Step 6: Commit and push**

```bash
git add README.md CLAUDE.md
git commit -s -m "Document per-task model delegation

Records the two new suggest_task parameters, and the tier rule in the
agent-driver seam — a driver that ships untiered models silently opts out
of delegation, which is worth saying where someone adding an agent reads."
git push -u origin task-model-delegation
```

Push to `origin` (your fork) only. Do not open a pull request — that would target the upstream repo.

---

## Verification checklist

- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] `npx tsc --noEmit` clean
- [ ] A suggested task created with a valid model persists it; a bogus one falls back to null and the agent gets a note
- [ ] The bridge forwards both fields (`tests/orchMcp.test.ts`)
- [ ] Both modals show the pickers; both card views show the badge
- [ ] A real planning turn produces tasks on more than one model
