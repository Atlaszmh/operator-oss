# Operator handoff skill — design

**Date:** 2026-08-07
**Status:** Approved

## Goal

Let a user plan work in an ordinary Claude Code session — anywhere, in any repo — then say
"hand this off to Operator" and have the session file the whole plan into a running Operator
instance: feature(s) with shared context, tasks with self-contained briefs, dependency edges,
per-task model + reasoning level, and an optional one-click autopilot arm. The skill ships in
this repo so any Operator user can install it.

## Decisions (user-approved)

- **Distribution: plugin marketplace.** The repo root becomes a Claude Code plugin
  (`.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`), so
  `/plugin marketplace add iishyfishyy/operator-oss` → install works, and the skill folder
  stays copyable into `~/.claude/skills/` for non-plugin users.
- **Handoff mode: suggestions + offer autopilot.** Tasks file with `suggested: true`
  (Operator's tray), then the skill offers `POST /api/features/[id]/approve-plan` — the same
  gate the UI uses, which accepts every suggestion, cuts the integration branch, and starts
  the queue when autopilot is on. Nothing runs without an explicit go.
- **Mechanism: pure SKILL.md driving `curl` against the existing REST API.** No new server
  code, no helper script, no MCP server. The skill fetches `/api/agents` and `/api/projects`
  live at handoff time, so model lists and project ids are never hardcoded into the prompt
  (same anti-rot argument as `buildDelegationGuidance()`).

## The API recipe the skill teaches

All endpoints already exist; the skill adds zero server surface.

| Step | Call |
|-|-|
| Preflight | `GET /api/projects` (also the reachability check) |
| Run-config menu | `GET /api/agents` → connected agents, `capabilities.models[]` (tiers `light/standard/heavy/max`), `reasoningOptions[]`, `permissionModes[]` |
| Resolve project | match cwd repo against `repo_path`, else name match, else offer `POST /api/projects` or ask |
| Feature | `POST /api/features` `{project_id, name, description, context}` — 409 → offer reuse of the named feature |
| Feature chaining | `PATCH /api/features/[id]` `{depends_on: [featureIds]}` (multi-feature plans) |
| Tasks | `POST /api/tasks` `{project_id, feature_id, title, description, priority, agent, model, reasoning, suggested: true}` — capture returned ids |
| Task dependencies | `PATCH /api/tasks/[id]` `{depends_on: [taskIds]}` — cycle-guarded, 400 → fix and retry |
| Arm autopilot (offered) | `POST /api/features/[id]/approve-plan` — flag-off returns a readable 400, surfaced verbatim |

## Skill flow

1. **Preflight.** Read `OPERATOR_URL` (default `http://localhost:3000`) and optional
   `OPERATOR_CF_ACCESS_CLIENT_ID` / `OPERATOR_CF_ACCESS_CLIENT_SECRET` env. Unreachable /
   403 → a readable explanation (start Operator, set the env var, or mint a Cloudflare
   Access service token for tunneled instances).
2. **Resolve the project** (table above). Container instances see different `repo_path`s
   than the host, so name match is a first-class path, not a fallback of last resort.
3. **Distill the plan from the conversation.** Feature name + spec (→ `features.context`,
   inherited by every member task's turns), and per-task self-contained briefs. The skill
   states the contract explicitly: the receiving session sees ONLY project context + feature
   context + its own title/description — never this conversation.
4. **Pick run config from live data.** Map each task's difficulty to a tier
   (light = mechanical, standard = routine, heavy = complex, max = hardest / largest
   context), then tier → whatever model currently carries it in the descriptor. Reasoning
   from `reasoningOptions[]`. Never name a model that isn't in the live list.
5. **Confirm once.** One mapping table (tasks × model/reasoning/priority/deps) before any
   write.
6. **File it** (calls above), then report keys (`ABC-F1` / `ABC-T2`) and the Operator URL.
7. **Offer approve-plan.** One question; on yes, POST it and report branch + accepted count.

## Auth

- Local instance (most users): no auth, default URL works.
- Cloudflare Access instance: general API routes require an Access JWT (middleware.ts), which
  the edge injects only when the request carries a valid **CF Access service token**
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers) through the tunnel hostname.
  The app-level `SERVICE_TOKEN` deliberately does not open these routes. The skill sends the
  CF headers when the env vars are set; the README section documents minting the token.

## Files

- `skills/operator-handoff/SKILL.md` — the skill (all inline; no supporting files).
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — plugin + marketplace
  manifests, repo root as plugin root.
- `README.md` — "Plan in Claude Code, hand off to Operator" section: install one-liner,
  env vars, CF Access note.

## Testing

TDD-for-skills against a throwaway Operator container (fresh volume, no CF Access, port
10002): baseline subagent run WITHOUT the skill (document failure modes), then the same
scenario WITH the skill, asserting the filed feature/tasks/deps/models via GET. The
throwaway is destroyed afterward; no test touches a real instance's database.

## Non-goals (add when a real handoff shows the need)

- Status pull-back from Operator into a Claude Code session (reverse direction).
- Helper scripts or an MCP server.
- New API endpoints, or auth changes beyond documenting what exists.
