# CLAUDE.md

Orchestrator — a local-first web app that runs many Claude Code sessions in parallel across multiple projects from one screen. Each **project** carries reusable context + a working directory; each **task** is its own Claude Code session in its own git worktree, driven by `@anthropic-ai/claude-agent-sdk` against the user's local Claude login (no API key). An optional **feature** groups tasks between the two (see "The feature layer"). (A hosted version, getoperator.dev, lives in a separate private repo that overlays this one — see "Repo split" below.)

## Commands

- `npm run dev` — app (:3000, `server.js`) + pty sidecar (:3001, `pty-server.js`) via concurrently. `npm run dev:next` / `npm run pty` run them separately.
- `npm run build` (turbopack) then `npm start` for production.
- `npm test` — vitest, serial on purpose (tests spawn many real git subprocesses). Single file: `npx vitest run tests/merge.test.ts`.
- No lint script; TypeScript is strict, path alias `@/*` → repo root (mirrored in `vitest.config.ts`).

## Architecture

Three processes/entrypoints, one origin:

- **`server.js`** — custom Next.js server (plain Node, CommonJS). Fronts Next on one port, proxies `/pty` WebSocket upgrades to the sidecar, forwards dev HMR upgrades to Next, enforces origin auth on WebSocket upgrades (middleware never sees upgrades — this file is the auth boundary for the terminal), and dispatches public service hostnames (`<slug>--<appHost>`) through `lib/service-router.mjs`.
- **`pty-server.js`** — node-pty sidecar, bound to `127.0.0.1` only; never exposed directly.
- **Next app** — UI in `app/`, REST under `app/api/`, server logic in `lib/`.

### The turn lifecycle (core flow)

`POST /api/tasks/[id]/messages` doesn't run the turn — it calls `startTurn()` in **`lib/runner.ts`** and returns. The turn runs detached, owned by the server process: every event is persisted to SQLite and fanned out via **`lib/events.ts`** (in-process pub/sub keyed by task id, plus a wildcard channel — `subscribeGlobal()` — that sees every task's events). `GET` on the same route is the SSE watch stream: a `snapshot` of the persisted transcript, then a live tail — reconnect-safe, any number of viewers, zero viewers fine. Stopping is only explicit (`lib/abort.ts`). If a turn is already running, POST parks the message in `pending_messages` to run next.

Only the SELECTED task has a transcript stream open. Everything else stays live through `GET /api/events` — one always-open EventSource per tab (`app/orchestrator/useGlobalEvents.ts`) broadcasting coarse lifecycle events for every task across every project (turn started / awaiting input / answered / suggestion created / turn ended). Each payload re-reads the task row at publish time — the runner persists BEFORE it publishes, so the snapshot is authoritative (pinned by `tests/agentDriver.test.ts`); it also carries the project's fresh awaiting count. That's what updates spinners, project badges, and the "N need you" pill for unselected tasks — there is no task-list polling.

**`lib/agents/`** is the agent-driver seam: the app talks to coding agents only through the `AgentDriver` interface (`types.ts` — normalized `StreamEvent` turn contract, one-shot summarize/draft/recap helpers, capability descriptor, login/verify auth surface), resolved via `getDriver(task.agent)` in `registry.ts` (`tasks.agent`, defaulted from `projects.default_agent`; unknown ids fall back to Claude). `shared.ts` holds the agent-agnostic normalizers (project-context/conflict prompts, tool-call → title/peek/diff, the event queue). `GET /api/agents` exposes each driver's capabilities to the client. Session/thread ids are opaque per driver (`sessions.claude_session_id` stores any driver's id).

**`lib/agents/claude/driver.ts`** is the Claude Code driver: `runTurn()` via the Agent SDK (resume or fresh session; project context is appended to the Claude Code system prompt via `buildProjectContext()`), the `suggest_task`/`expose_service` MCP tools, `summarizeTranscript()` for `/clear`, `draftProjectContext()` (read-only repo-exploring agent); auth delegates to `lib/claude-auth.ts`. Sessions run `permissionMode: "bypassPermissions"`. **`lib/agents/codex/driver.ts`** is the OpenAI Codex driver (`@openai/codex-sdk` spawns the `codex` CLI, JSONL over stdio; `codex/events.ts` normalizes its `ThreadEvent` stream); its one-shot helpers are `codex exec` runs in a read-only sandbox. Non-Claude drivers get the orchestrator tools (`suggest_task`/`expose_service`/`ask_user`) via the stdio MCP bridge `scripts/orch-mcp.mjs` → `/api/internal/agent-tools/*`; `ask_user` restores interactive asks (card persisted + published by `lib/agentTools.startAskUser`, bridge polls the `wait` endpoint for the answer).

**Internal jobs run through `lib/agents/oneshots.ts`** — the turns that run *outside* the main chat. Two policies: **task-scoped** (`/clear` transcript summarization) follows the **task's own agent** (so a Codex task's handoff note bills the Codex login); **project-scoped** (recap, "Refresh with AI" context draft) runs the **utility agent**, resolved **connected-first** (`utility_agent` setting if connected → app default → built-in default → any connected agent; nothing connected → actionable error, never a dead CLI). A driver that doesn't implement a helper is backstopped by the utility agent, so the one-shot helpers on `AgentDriver` are optional — only `runTurn()` is required. The first-run wizard requires **an** agent, not Claude: finishing with only Codex connected adopts it as the app default and retargets the seeded tutorial (`completeOnboarding` in `lib/onboarding.ts`). AI conflict-resolution turns need no special routing: the client sends `buildConflictPrompt()` output as an ordinary message through `startTurn()` → the task's driver.

**Adding a third agent**: implement `AgentDriver` in `lib/agents/<id>/driver.ts` (only `runTurn()` is required), register it in `registry.ts`, ship its CLI in the `Dockerfile`. Nothing else changes — the runner, routes, recap/refresh jobs, and UI data flow are all seam-generic. Pin it with the driver-contract test (`tests/agentDriver.test.ts`, which mocks a driver's CLI at the SDK boundary and runs it through the real runner).

**Model delegation**: a driver's `models[]` entries may carry a `tier` (`light`/`standard`/`heavy`/`max`) marking them as `suggest_task` delegation targets — `buildDelegationGuidance()` in `lib/agents/shared.ts` generates the planner's menu and routing rubric from those, so the prompt can't rot into naming a model the picker no longer offers. At most one model per tier (`tests/delegation.test.ts`); sparse tiers fold onto the nearest present one, so a two-model agent still covers all four categories of work. Untiered options stay picker-only — a human can pin a legacy version, a planner is never offered one — but `validateRun()` in `lib/agentTools.ts` *accepts* any value in the descriptor, tiered or not. Ship no tiers and the driver simply opts out: the tool behaves exactly as it did before per-task delegation existed.

**A task is a lineage of sessions**: `/clear` ends generation N, condenses its transcript to a summary, and generation N+1 starts fresh seeded with all prior summaries.

**The outcome line** (`tasks.outcome`): every turn's project context ends with `OUTCOME_INSTRUCTION` asking for one business-facing sentence on a marked line when the agent finishes work; the runner lifts it out of each assistant message with `extractOutcome()` (both in `lib/agents/shared.ts`, together so the marker can't drift from its parser) and writes it in the same settle that clears `running`. Latest report wins; a turn that reports nothing leaves the previous line standing. A marked line rather than an MCP tool ON PURPOSE — text needs no per-driver tool definition or bridge route, so it works identically on Claude, Codex and whatever lands next. Rendered on the task card and under each member on the feature page (a feature's business summary is just its members' lines stacked, so there's nothing extra to generate or keep in sync).

### The feature layer

`features` is the optional level between a project and its tasks (`tasks.feature_id`, nullable). **Everything about it is opt-in — `feature_id NULL` is the pre-feature behaviour, byte for byte**, including how the tasks column groups (feature groups render *above* the existing status groups, which then hold only the ungrouped tasks).

Three things a feature owns, each independently optional:

- **Shared context.** `features.context` is emitted by `buildProjectContext()` between the project context and the task framing. It lands in *every turn of every member task*, so it is spec-sized by convention, not by enforcement.
- **An integration branch.** `features.branch` (`''` = off). When set, member tasks base off and merge into it instead of `projects.branch`, and the feature lands on the project branch as one unit. **`taskBaseBranch(task, project)` in `lib/store.ts` is THE resolution point** — every merge/sync/PR/worktree path routes through it, so a caller that forgets features can't exist. `ensureWorktree(repo, taskId, baseBranch?)` already took a fork point (absent/unknown → HEAD); features only changed what gets passed to it — `taskBaseBranch(task, project)` instead of `project.branch`.
- **Agent planning.** `suggest_feature` (upsert by name) + `suggest_task({feature})` (unknown name auto-creates, because a planner that gets twenty errors files nothing). Both mount paths share `lib/agentTools.ts`, same split as `suggest_task`.

Two deliberate departures worth knowing before you "fix" them:

- **`ON DELETE SET NULL`, not CASCADE** — the one exception to "delete is hard delete". A feature is a label *over* tasks, not what they are; deleting the grouping must not destroy the work filed under it. Pinned by `tests/features.test.ts`.
- **No `status` column** — progress is derived in `listFeatures()`. A stored status would need writing from every path that touches `tasks.status` and would drift the first time one was missed.

### Autopilot (opt-in, `ORCH_FEATURE_AUTOPILOT`)

**`lib/autopilot.ts` walks an approved plan so the user doesn't have to.** Two human gates, and everything between them is machine-driven: `POST /api/features/[id]/approve-plan` (accept every suggestion, cut the integration branch, flip `features.autopilot`) and the PR the feature ends at (`features.pr_url`). Nothing else asks for a click.

`sweep(projectId)` is the whole controller: gate every member that handed back, start ready members up to `AUTOPILOT_CONCURRENCY`, open the feature PR when the last one lands. **Driven by `subscribeGlobal()`'s `turn_end`, not a timer** — a turn ending is exactly when there's new work to consider. It's idempotent and serialized per project (a second caller marks the project dirty rather than racing), so the safety sweep on the recap cadence can overlap it freely. `ensureAutopilot()` arms the subscription from `/api/events` and the recap sweep, because `server.js` is plain CommonJS and there is no boot hook to use.

**`readyMembers()` in `lib/store.ts` is the first consumer `task_dependencies` ever had** — the graph was always writable via `suggest_task({blocked_by})` and rendered as a badge, but nothing scheduled off it.

**`lib/gates.ts` is what replaces a human reading the transcript**: `test_command` run in the **task's worktree** (NOT via `lib/services.ts`, which spawns in `repo_path` and would prove nothing about the branch being merged), then a reviewer one-shot. The reviewer is **project-scoped** through `lib/agents/oneshots.ts` so it runs on the utility agent, never the task's own — a model must not grade its own homework. A red suite short-circuits the review. `parseVerdict()` **fails closed**: an unparseable reply is a FAIL, because the alternative is a malformed review silently merging code. Marker and parser sit together in `shared.ts`, same rule as `OUTCOME_INSTRUCTION`/`extractOutcome`.

Escalation is the `promptLimits`/`authFailure` durable-notice pattern: `tasks.blocked_reason` + `awaiting_input`, so a stuck task lights up the existing "N need you" pill with no new notification surface. **Any human message clears `blocked_reason` and `gate_attempts`** — answering it is how you resume it. Blocked tasks never stall siblings; their dependents simply never become ready.

`startInitialTurn()` lives in `lib/runner.ts` beside `startResumeTurn()` because autopilot and `POST /messages` both need the identical claim → worktree → title+description sequence.

Deliberate corners: a task is **not re-gated when its base moves during the gate** (CI on the feature PR is the arbiter of the combined state; re-gating would serialize the fan-out the cap exists to allow — marked with a `ponytail:` comment), and there is no `features.autopilot_state` column (derived in `listFeatures()`, same argument as the missing feature status). **Shadow mode (`ORCH_FEATURE_AUTOPILOT_SHADOW`, ON by default) gates but never merges** — enabling autopilot can't land code on its first run.

`landBranch()` in `lib/git.ts` is `mergeTask` minus the commit step, split out so `mergeFeature` (no worktree to commit) lands through the same code. `createBranchPr()` is the same split in `lib/github.ts` — `createTaskPr` passes the worktree as `cwd`, a feature passes `repo_path`. `worktreeSyncStatus`'s `worktreePath` is optional for the same reason — only the dirty check needs one. Feature-level merge conflicts are reported, not resolved in-app (marked with a `ponytail:` comment in the sync route).

### Key modules (by responsibility)

- `lib/db.ts` — SQLite schema + migrations (single shared connection, WAL); `lib/store.ts` — typed queries; `lib/types.ts` — shared types.
- `lib/git.ts` — per-task worktrees/branches, diffs, merge (`mergeTask`, `landBranch`, `mergeFeature`, `prepareWorktreeMerge`/`completeWorktreeMerge`/`abortWorktreeMerge`), base-branch sync (`worktreeSyncStatus`/`fastForwardWorktree`), feature integration branches (`createFeatureBranch`).
- `lib/services.ts` — managed-services supervisor (detached process-group children owned by the server, log ring buffers, SSE status); `lib/service-router.mjs` + `lib/service-host.mjs` — public service-hostname reverse proxy + pure host/token helpers.
- `lib/contextRefresh.ts` — "Refresh with AI" as a detached background job (poll via GET, never a long-held request); `lib/recap.ts` — staleness/activity sweep. Both are project-scoped one-shots that run on the utility agent via `lib/agents/oneshots.ts`. `lib/idle.ts` — busy-tracking so the idle daemon won't stop the container mid-work.
- `lib/promptLimits.ts` / `lib/authFailure.ts` — the two *recoverable* turn failures, classified agent-agnostically from the error text. Each appends a durable notice to the persisted transcript line, which the UI matches verbatim to render one recovery button (`/clear` for context overflow, Reconnect for a dead login). A dead login additionally parks the pending queue (every follow-up would fail identically) and flags the agent instance-wide (`agent_auth_broken_<id>` in `lib/agents/connections.ts`, relayed on `/api/events` as an `agent_auth` event) so the titlebar banner shows in every tab; any successful turn clears it.
- `lib/config.ts` — all per-instance config, env-driven with documented defaults; `lib/features.ts` — feature flags (env → `resolveFeatures()` server-side, `window.__FEATURES` client-side).
- Auth: `middleware.ts` gates every HTTP route (no matcher on purpose); provider selected by `lib/auth/origin.mjs` (open local mode by default, Cloudflare Access when `CF_ACCESS_*` is set); threat model in `lib/cf-access.mjs`. Health/version routes accept the shared `SERVICE_TOKEN` instead.
- UI: `app/Orchestrator.tsx` is the three-column shell (projects · tasks · live session); the pieces live in `app/orchestrator/` (`useTaskStream.ts` owns the one-EventSource-per-task logic, `SessionRail.tsx` the DIFF/PREVIEW/CONTEXT tabs). `app/Terminal.tsx` is xterm.js over the `/pty` proxy.

### Repo split (OSS ↔ hosted)

This is the **open-source repo** — the whole local app lives here and all core development happens here. The hosted product (control plane, billing, fleet provisioning, first-party auth, deploy scripts) lives in a **private overlay repo** that tracks this one as upstream: it re-adds the private files and carries hosted variants of a few fork-point files (`middleware.ts`, `lib/auth/origin.mjs`, `server.js`, `app/api/auth/logout/route.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, this file). Don't add hosted/control-plane features here; don't reference private scripts or docs from public files.

### Where data lives

| What | Where |
|-|-|
| DB (projects, features, tasks, transcripts, summaries) | `orchestrator.db` in `ORCH_DB_DIR` (default `~/.zen-orchestrator`) |
| Per-task git worktrees | `ORCH_WORKTREES_DIR` (default `~/.agent-orchestrator/worktrees`) — deliberately **outside** every repo |
| Cloned project repos | `ORCH_PROJECTS_DIR` (default `~/projects`) |

## Conventions & gotchas

- **Env-driven, zero code edits per instance.** Every per-instance knob is an env var with a documented default — add new ones to `lib/config.ts` (or `lib/features.ts` for flags) **and** `.env.example`. `server.js`/`pty-server.js` can't import TS, so they read the same env names directly; keep names in sync.
- **Plain-Node entrypoints stay plain.** `server.js` is CommonJS; anything it needs from `lib/` must be `.mjs` (dynamic-imported) — and every such `.mjs` file must be COPY'd into the runtime image in the `Dockerfile` (Next's build output doesn't include them; this has bitten before).
- **`next.config.mjs` stays JS**, not TS — prod containers prune dev deps and a `.ts` config needs the `typescript` package at runtime.
- **HMR-surviving server state lives on `globalThis`** (`lib/events.ts`, `lib/abort.ts`, `lib/asks.ts`, `lib/services.ts` all follow this pattern). Single Node process; no external queue/broker.
- **Long work is a detached background job, never a held HTTP request** (turns, context refresh, services). Anything multi-minute must survive page reloads and tunnel drops, and should mark the instance busy via `lib/idle.ts` so the sleep daemon doesn't stop the container mid-work.
- **Native modules** (`better-sqlite3`, `node-pty`) and the Agent SDK are in `serverExternalPackages` — don't let Next bundle them. `postinstall` fixes node-pty's exec bit.
- **Tests are hermetic**: `tests/setup.ts` points `ORCH_DB_DIR`/`ORCH_WORKTREES_DIR` at tmp dirs and pins git config *before the module graph loads* (config is read at import time). Use `tests/helpers.ts` for git fixtures. New env-read-at-import config must be set there too.
- **Delete is hard delete** throughout — no soft-delete/undo.
- **Auth is layered on purpose**: Next middleware for HTTP, `server.js` for WebSocket upgrades, per-service visibility for public service hostnames. When adding a route or upgrade path, decide which gate covers it.
- **Commits are detailed** (explain the why); **keep README.md current** with app state when behavior changes. Markdown tables use minimal separators (`|-|-|`).

## More detail

`README.md` (features, configuration, self-hosting, architecture map) · `.env.example` (every env var, documented).
