---
name: operator-handoff
description: Use when a plan from this session should be built in the user's Operator instance — "hand this off to Operator", "send this to Operator", "file these tasks in Operator", "implement this plan in Operator and approve it to kick off", "kick this off in my orchestrator" — or when the user wants planned work to run as parallel agent sessions instead of in this session. Covers both filing the plan and approving it so autopilot starts building immediately.
---

# Operator Handoff

## Overview

File a plan from this conversation into a running Operator instance over its REST API: one feature carrying the spec, member tasks as **suggestions** with per-task model/reasoning and dependency edges, then offer **approve-plan** to start the queue. The receiving sessions never see this conversation — everything they need must land in the fields below.

## Connection

| Env var | Meaning |
|-|-|
| `OPERATOR_URL` | Base URL, default `http://localhost:3000` (Docker installs often use `http://localhost:10001`) |
| `OPERATOR_CF_ACCESS_CLIENT_ID` / `OPERATOR_CF_ACCESS_CLIENT_SECRET` | Only for instances behind Cloudflare Access: sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers on every request, via the tunnel hostname |

Preflight with `GET $OPERATOR_URL/api/projects`. Connection refused → tell the user to start Operator or set `OPERATOR_URL`. 403 → the instance is behind Cloudflare Access; they need a CF Access **service token** (Zero Trust → Access → Service Auth) added to the Access policy, in the env vars above. The app's own `SERVICE_TOKEN` does NOT open these routes.

## The recipe

Complete for a handoff — do not probe for other endpoints. All bodies JSON.

| Step | Call |
|-|-|
| Preflight + project list | `GET /api/projects` |
| Live model/reasoning menu | `GET /api/agents` |
| Create project (only if missing) | `POST /api/projects` `{name, repo_path, branch?}` |
| Create feature | `POST /api/features` `{project_id, name, description, context}` |
| Feature chain (multi-feature plans) | `PATCH /api/features/{id}` `{depends_on: [featureIds]}` |
| Create task | `POST /api/tasks` `{project_id, feature_id, title, description, priority, agent?, model, reasoning, suggested: true}` |
| Task dependencies | `PATCH /api/tasks/{id}` `{depends_on: [taskIds]}` — **after** creating; ids from the POST responses, not keys |
| Approve the plan — starts the queue | `POST /api/features/{id}/approve-plan` |

**On a Cloudflare-Access-gated instance**, none of the above is reachable without a CF Access service token — but the internal agent-tool paths authenticate on the app's own `SERVICE_TOKEN` (`x-service-token` header, against `http://localhost:<port>`, never the tunnel hostname) and cover the whole handoff: `POST /api/internal/agent-tools/suggest-feature` `{projectId, name, description, context, after}` · `suggest-task` `{projectId, feature, title, description, priority, model, reasoning, blocked_by}` · `approve-plan` `{projectId, feature}`. Differences that bite: `after`/`feature` take NAMES and `blocked_by` takes IDS (all inline, no PATCH pass); `suggest-feature` upserts by name but `suggest-task` always inserts, so a re-run duplicates every task.

## Field truths (get these right)

- **`features.context` is the spec.** It is injected into *every turn of every member task*. `features.description` is a display blurb only — a spec put there is never seen by any agent. Write the full agreed spec into `context`.
- **`suggested: true` on every task.** Approve-plan accepts *suggestions*; a task filed without it sits as a manual card and the autopilot queue skips it.
- **`depends_on` is PATCH-only.** `POST /api/tasks` silently drops it. Create all tasks first, collect their `id`s, then PATCH each task's dependencies.
- **Task `description` is the whole brief.** The receiving session sees only: project context + feature `context` + the task's title/description. Write each description self-contained — concrete scope, files/modules if known, acceptance criteria, what NOT to touch. One-liners produce guesswork.
- **`priority`**: `hi` | `med` | `lo`.

## Model + reasoning

Fetch `GET /api/agents` at handoff time; never hardcode model names. Use a `connected` agent (none connected → warn, file anyway — filing doesn't need one). Pick from that agent's `capabilities.models[]` by `tier`, and `reasoningOptions[]` values (Claude: `off` | `think` | `think_hard` | `ultrathink`):

| Tier | Work | Reasoning guide |
|-|-|-|
| `light` | mechanical: renames, boilerplate, config | `off` |
| `standard` | routine, well-specified implementation | `off`–`think` |
| `heavy` | complex logic, security-sensitive, cross-cutting | `think`–`think_hard` |
| `max` | hardest problems, huge-context work | `think_hard`–`ultrathink` |

## Flow

1. Preflight; `GET /api/agents`.
2. Resolve the project: match cwd's repo against `repo_path` **or name** (containerized instances see different paths than this machine — a name match is normal). No match → ask, offering to create one; `repo_path` must be the path *as Operator sees it* (browse `GET /api/fs?path=...` to find it).
3. Distill the plan: feature name, spec → `context`, one-line `description`, tasks with self-contained briefs, deps, tier + reasoning each.
4. **Show one confirmation table** (task × model/reasoning/priority/depends-on) and the feature spec destination. File nothing before the user confirms. **If the user already said to approve/kick off** ("…and approve it to kick off", "file it and start it"), say so in that same confirmation — "I'll file this and approve it, so it starts building immediately" — so approval rides the confirmation they are already giving. Do not re-ask afterwards.
5. File: feature (409 → an identically-named feature exists; ask before reusing it) → tasks (capture `id` + `key`) → dependency PATCHes.
6. Approve, if that was the agreed intent — POST approve-plan for the **head** feature. It accepts every suggestion, cuts the integration branch, arms autopilot and starts the queue. Otherwise **offer** it. A 400 means autopilot is off on that instance — surface its message verbatim; the suggestions are still fine to start by hand.
7. Report the feature/task keys (`ABC-F1`, `ABC-T2`, from `key`), link `$OPERATOR_URL`, and when approved the `branch` + how many suggestions were `accepted`.

## Common mistakes

| Mistake | Reality |
|-|-|
| Spec in `features.description` | Agents never see it; `context` is the inherited field |
| `depends_on` in task POST | Silently dropped; PATCH after creation |
| Omitting `suggested: true` | Approve-plan has nothing to accept |
| Inlining JSON on the curl command line | Non-ASCII (em-dashes, arrows) mangles on Windows shells; write the body to a UTF-8 temp file, `curl --data-binary @file` |
| Hardcoding a model id | Menus differ per instance/agent and change over time; read `/api/agents` |
| Probing for endpoints | The recipe above is complete; unknown routes 404 |
| Editing/deleting existing Operator data | Out of scope — a handoff only adds |
