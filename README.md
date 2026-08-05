<div align="center">

# Operator

### Run many Claude Code sessions in parallel — across every project — from one screen.

Each **project** carries reusable context. Each **task** is its own agent session — **Claude Code** or **Codex** — in its own git worktree. Drive ten at once, see exactly which one needs you, review every diff before it merges. Runs on your **Max/Pro login** — no API key, no per-token billing.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node ≥18.18](https://img.shields.io/badge/node-%E2%89%A518.18-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-8A2BE2.svg)](CONTRIBUTING.md)

<!-- TODO(video): replace this screenshot with a 30–45s screen capture (GitHub hosts .mp4
     dragged into the README editor). Shot list: create a task → two tasks streaming at
     once → the "N NEED YOU" pill fires → jump to the task → review the diff → one-click
     merge. Keep the PNG below it as a fallback. -->
![Operator workspace](docs/images/workspace.png)

</div>

## Why

- Your Claude plan can run more than one session at a time — stop working it one terminal at a time.
- One screen for every project and every task. No tab-juggling.
- Project context is written once and injected into every task. Stop re-explaining your stack.
- A cross-project **"N need you"** signal shows exactly which session is waiting on you.

## Features

- **Parallel sessions** — every task is an isolated git worktree with its own agent session.
- **Diff review → one-click merge** — or AI conflict resolution, branch sync, and GitHub PR creation.
- **Pick your agent per task** — Claude Code or Codex, both on subscription logins.
- **Model delegation** — when an agent plans work, it picks the model and thinking budget for each task it proposes, so a rename doesn't run on your most expensive model and a refactor doesn't fail on your cheapest. Its choice shows on the task card and is editable before the task starts.
- **Optional feature layer** — group related tasks under a feature (project › feature › task). It carries context every task in it inherits, shows progress at a glance, and can own an integration branch its tasks base off and merge into, so the whole thing lands on `main` as one unit. Agents plan into it with `suggest_feature`. Entirely optional: a task with no feature behaves exactly as before.
- **Feature branches keep themselves current** — the moment anything lands on your project branch, every other live feature branch merges it in. You stop discovering at ship time that the world moved three features ago: a conflict now surfaces minutes after the merge that caused it, one feature wide, while the session that wrote it is still warm. When a branch genuinely can't follow, it says so on its own tile instead of failing someone else's merge.
- **Conflicts resolve themselves too** — a feature branch that can't follow files a *resolution task*: an ordinary task on that branch, briefed on the conflicted files, whose diff you review and merge like any other work. On an autopilot feature it's adopted and resolved unattended; otherwise it waits in the tray as a one-click Start, and the feature page has a "Resolve with AI" button that starts it on the spot.
- **Optional push-on-ship** — shipping is a local git merge by default. Set `ORCH_FEATURE_PUSH_ON_SHIP=1` and every landing on your project branch pushes to `origin` too, so "Ship" means shipped rather than shipped-on-this-machine. Best-effort: an unreachable remote is reported, never fatal — the merge stays landed and rides along with the next successful push.
- **Work can't strand silently** — archiving a feature whose branch still holds unlanded commits gets a "this will strand N commits" confirm first; a branch that gains commits *after* shipping says so on its tile; and a ship stamp that goes missing is healed from what git actually shows.
- **Shipped, or not** — a feature's header says which: **Shipped** once its integration branch has landed (or, with no integration branch, once every task in it is done *and* merged), **In review** while its PR is open, **Done** when the work is finished but hasn't all landed. Shipped features desaturate, fold shut, and sink below the live ones, then move into a collapsed **Archived** section — automatically when you ship one, or on one click from the header. Nothing is deleted, their tasks stay filed under them, and Restore brings a feature back.
- **Keys** — every task and feature gets a JIRA-style identifier (`TME-42`) from its project's prefix, so there's something to paste into a commit message or send to someone. Search and ⌘K both match on it. The prefix is derived from the project name and editable in the project's context editor; changing it re-keys everything in that project at once.
- **Autopilot** *(opt-in)* — approve a feature's plan once and it runs itself: tasks start in dependency order, each one gates on your test suite plus an independent reviewer agent before merging into the feature's integration branch, and the finished feature comes back as a single pull request. You're asked for exactly two things — approving the plan, and merging that PR. See [Autopilot](#autopilot).
- **Outcome in plain language** — every session is asked to end its finished work with one business-facing sentence on what you actually got ("Customers can pay with Apple Pay", not "refactored `checkout.ts`"). It lands on the task card and stacks up on the feature page, so you can read what shipped without opening a single transcript.
- **Write-once project context** — auto-injected into every task; **Refresh with AI** redrafts it from the repo.
- **Session lineage** — `/clear` hands a summary to a fresh context window; the task lives on.
- **Reconnect-safe turns** — turns run server-side; reload or sleep the laptop and the transcript catches up. Queue follow-ups mid-turn.
- **Knows when your agent login dies** — an expired sign-in raises a workspace-wide banner with a one-click reconnect (plus the same button in the failed transcript). Queued follow-ups stay queued instead of failing one by one, and the banner clears itself the moment a turn runs again.
- **Integrated terminal + managed services** — a real shell per project, plus supervised dev/setup/test processes that survive restarts, with live logs and optional public URLs.
- **Honest usage tracking + insights** — live per-task tokens and spend, plus a local analytics dashboard. The chip leads with tokens the agent actually processed and keeps prompt-cache re-reads (usually most of the raw total) as secondary detail; on a subscription login the dollar figure is labelled as an API-price equivalent covered by your plan, not a bill.
- **List or kanban board** — flip the workspace to a full-width board of live status columns (Suggested / Not started / In progress / Needs input / Done); drag cards to reorder or change status, click one to open its session in a slide-over. ⌘⇧B toggles.
- Plus: agent-suggested tasks, task dependencies, image attachments, clone from GitHub, recaps, a first-run tutorial.

**Watch the session stream — tool calls, edits, questions:**

![Session transcript](docs/images/session.png)

**Review the diff next to the chat, then merge (or open a PR):**

![Diff review and merge](docs/images/changes.png)

**A real terminal, right in the workspace:**

![Integrated terminal](docs/images/terminal.png)

## Supported coding agents

| Agent | Status |
|-|-|
| **Claude Code** | Fully supported — the reference driver; every feature lands here first. |
| **OpenAI Codex** | Fully supported — parallel tasks, diff review/merge, `/clear` lineage, interactive questions (via the orchestrator's `ask_user` bridge), and cost tracking. Two caveats from the upstream CLI being non-interactive: dollar figures are **estimated** from token counts × published API prices (ChatGPT-plan auth reports tokens only — shown with a `~`), and there are no mid-turn *command approval* prompts, so the permission modes offered are Auto-run and Plan. [Issues welcome](https://github.com/iishyfishyy/operator-oss/issues). |

Want another agent? The driver seam is small — see [adding a new agent](docs/ARCHITECTURE.md).

## Insights

Open **Insights** from the top bar for a local analytics dashboard of what your agents cost and ship: per-day spend and token usage (including cache reads/writes), tasks shipped, and lines merged to base — sliceable by project and agent across 7/30/90-day ranges, with deltas against the prior period. Everything is computed from the local SQLite database in a single fetch, filter changes recompute instantly in the browser, and nothing is sent anywhere. Claude spend is the SDK-reported dollar figure; Codex spend is estimated from token counts at published API prices and marked with a `~`.

### Reading the numbers

The per-task chip in the session header reads `250k tok · 3.5M cached · ~$4.20`, and each part means something different:

| Part | What it means |
|-|-|
| `250k tok` | Tokens the agent processed for the first time: prompt, completion, and context written into the prompt cache. This is the headline because it's the work that actually happened. |
| `3.5M cached` | Prompt-cache **reads**: the conversation so far, re-sent every turn and billed at ~10% of the input rate. It dominates the raw token total on any long task and is not 3.5M tokens of new work. |
| `~$4.20` | On a **Max/Pro or ChatGPT subscription login** this is an *API-price equivalent*: what those tokens would have cost through the API. Your turns draw on plan quota, so the marginal cost is $0 and the figure carries a `~`. With an **API key** connected instead, it's a real billed amount and shows plainly. Codex figures are additionally estimated (its CLI reports tokens only). |

Hover the chip for the exact counts and the full breakdown.

## Autopilot

Off by default. Set `ORCH_FEATURE_AUTOPILOT=1` to surface it.

Most tasks don't need you. They need someone to start them, notice they finished, check the tests still pass, skim the diff, click merge, and start the next one. Autopilot does that part, and keeps you for the two decisions that are actually yours.

**You approve the plan.** Open a task and talk to an agent until the spec is right — it writes the shared spec into the feature's context and files the breakdown with `suggest_feature` / `suggest_task({blocked_by})`. When you're happy, **Approve plan** on the feature page accepts every suggested task, cuts an integration branch off your project branch, and starts the queue.

Approving covers the work that arrives *later*, too: anything suggested into an approved feature — the rest of a planner's breakdown, or follow-up work a task discovers while building — is accepted and queued on its own, rather than waiting in the tray for a second click that says the same thing. You can approve an **empty** feature for the same reason: arm it, point a planning task at it, and the plan runs as it's written.

**Then it works.** Tasks whose dependencies have landed start in parallel, up to `ORCH_AUTOPILOT_CONCURRENCY` (default 2). When one finishes, it has to earn its merge:

1. Your project's `test_command` runs **in that task's worktree** — not the shared checkout, so what's tested is exactly what's about to merge.
2. A **separate reviewer agent** reads the diff against the task's brief and the feature spec, in the worktree, so it can open the files a hunk touches. It runs on the utility agent, never the one that wrote the code.

Pass, and the task merges into the integration branch and the next one starts. Fail, and the reviewer's notes go straight back to the task as its next turn — twice by default (`ORCH_AUTOPILOT_ATTEMPTS`), then it stops and asks you. A merge conflict goes to the task's own agent to resolve, same as the manual flow.

**You merge the PR.** When the last task lands, the integration branch is pushed and a PR opened against your project branch, its body assembled from the approved spec and every task's outcome line. Review it on GitHub, where CI and your review tools already live.

**When it gets stuck**, the task shows up in the "N need you" pill you already watch, with the reason in full on the feature page. Reply to it — answering clears the block and it picks the task back up. A stuck task never stalls its siblings; only work that depended on it waits.

**Start in shadow mode.** `ORCH_FEATURE_AUTOPILOT_SHADOW` is **on by default**: the full gate runs and records its verdict, but nothing merges without you. Leave it on until you've watched the reviewer judge a handful of tasks you'd also have judged. A reviewer that rubber-stamps has automated a rubber stamp, and this is the cheap way to find that out. Set it to `0` when you trust it.

Autopilot never merges to your project branch, and it's per-feature — nothing you haven't approved runs.

## Managed services

Give a project `dev` / `setup` / `test` commands in its context editor (⚙) and the
**Services** drawer runs them as supervised processes **owned by the server** — not by an
agent turn or a browser tab — so `npm run dev` keeps serving after the turn ends and the
tab closes, with live logs on reconnect. Agents can also register servers they started
via the `expose_service` tool.

- Each project gets a stable port (`ORCH_SERVICE_PORT_BASE` + slot), injected as `PORT`
  into its services and PTY shell.
- Services are **persisted**: a dev server that was running is auto-restarted when the
  app boots. If the server died hard (`kill -9`, OOM), the next boot **reaps the orphaned
  process group** before respawning, so restarts never fight zombies for ports; a clean
  shutdown kills its service processes on the way out.
- If the configured port is already taken by an unmanaged process, the service shows a
  readable error in the drawer instead of crash-looping.
- Log capture is bounded per service (`ORCH_SERVICE_LOG_LINES`, default 1500 lines).
- A running service does **not** block idle-stop (`GET /api/instance/idle` reports
  `runningServices` informationally): stopping the instance is safe because services
  restart on boot at the same URL.

**Public URLs are a separate opt-in.** Set `ORCH_SERVICE_HOSTS=1` (plus
`PUBLIC_BASE_URL` and wildcard DNS/TLS) and each service gets a stable hostname
`<slug>--<your-host>` with per-service visibility — **private** (your session only),
**shared** (tokened link), or **public**. Enabling the services feature alone exposes
nothing. Frameworks with host checks see the hostname as `ORCH_PUBLIC_HOST` in the
service's env: Vite → `server.allowedHosts: [process.env.ORCH_PUBLIC_HOST]`, Next dev →
`allowedDevOrigins: [process.env.ORCH_PUBLIC_HOST]`; CRA/webpack-dev-server is
pre-cleared via env.

Managed services are on by default; `ORCH_FEATURE_SERVICES=0` turns the whole feature off.

## Quick start

```bash
npm install
npm run build
npm start
# open http://localhost:3000
```

This is the production build — use it whenever you're actually *using* the app.
Hacking on Operator itself? `npm run dev` runs the dev server (Turbopack + React dev
build) with hot reload — but it compiles each route on first hit and is **much slower**,
so don't run it for day-to-day use.

You need **Node 18.18+**, **macOS or Linux**, and at least one agent CLI: **Claude Code**
(`npm i -g @anthropic-ai/claude-code`, Pro/Max plan — recommended) or **Codex**
(`npm i -g @openai/codex`, ChatGPT plan). First run opens a setup wizard that signs the
agent in from the browser — connecting **either one** completes setup (it becomes the app
default and the tutorial runs on it) — then drops you into a 2-minute hands-on tutorial.
A stray `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the launch environment is stripped at
boot (with a warning) so turns bill your subscription, not the API — set
`ORCH_ALLOW_API_KEY_ENV=1` if you really do want to run on an env-provided key.

Every setting is an env var with a sane default — see [`.env.example`](.env.example).

## Self-host

One hardened Docker container, built to sit behind an authenticated tunnel:

```bash
docker build -t agent-orchestrator .
ORCH_USER=alice ORCH_PORT=10001 docker compose -p orch-alice up -d
```

The port binds to loopback only — the app hands out a full shell, so put auth in front
and **never expose it raw**. Tunnels, Cloudflare Access, idle sleep, and every config
knob: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Hosted

Don't want to run a server? [**getoperator.dev**](https://getoperator.dev) is your own
always-on instance — works from your phone, zero setup. Same codebase plus a
closed-source control plane.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — how it works; the agent-driver seam; adding a new agent
- [Self-hosting](docs/SELF_HOSTING.md) — Docker, auth, configuration, caveats
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[Apache-2.0](LICENSE)
