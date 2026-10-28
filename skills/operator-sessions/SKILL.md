---
name: operator-sessions
description: Use when the user asks about, or wants to act on, work already running in their Operator instance from this session. Covers checking a ticket or task ("what's the status of CHU-T12", "what did the Operator session conclude", "is anything waiting on me"), reading a session's transcript, sending a prompt or follow-up into a running Operator session ("tell the T12 session to…", "ping Operator", "nudge that task"), answering a session's question card, and editing a task's title, description, priority, status, model or dependencies. To file NEW planned work into Operator, use operator-handoff instead.
---

# Operator Sessions

Read and steer the tasks (sessions) in a running Operator instance from an outside Claude Code session. Every call goes through `op.mjs` next to this file. It hits `/api/internal/agent-tools/*` with the instance `SERVICE_TOKEN`, which is the one surface that still works when Cloudflare Access gates the rest of the API.

```bash
node <skill-dir>/op.mjs <METHOD> <route> [json | @file.json] [--last=N]
```

| Env | Default |
|-|-|
| `OPERATOR_URL` | `http://localhost:10001`. Use localhost even if a tunnel exists, because the tunnel hostname needs an Access login. |
| `OPERATOR_ENV_FILE` | `../../.env` relative to the script, i.e. the operator-oss checkout. The token is read from its `SERVICE_TOKEN=` line. |

**Send bodies as `@file.json`.** Write the file with the Write tool first. An inline JSON argument with em-dashes or arrows can get mangled by the Windows shell.

## Routes

| Want | Call |
|-|-|
| All projects | `GET projects` |
| One project + its tasks and features | `GET projects/<id>` |
| Project settings | `PATCH projects/<id>` with any of `test_command, setup_command, dev_command, context, branch` (`test_command` gates every merge and ship, so confirm with the user first) |
| All tasks (key, status, running, awaiting_input, project_name) | `GET tasks` |
| One task + transcript, usage, deps | `GET tasks/<id>` (the last 20 messages by default, `--last=0` for all) |
| Prompt the session | `POST tasks/<id>/messages` `{"text": "..."}` |
| Edit the ticket | `PATCH tasks/<id>` with any of `title, description, priority (hi/med/lo), status, model, reasoning, depends_on: [ids], feature_id` |
| Answer a question card | `POST tasks/<id>/answer` `{"askId": "ask-…", "answers": [["chosen label"], …]}` |

Routes take the task's **id**, not its key. To resolve a key like `CHU-T12`, run `GET tasks` and match `key`.

## What the responses mean

- **messages → `202 {ok, generation}`**: a turn started. If the task was never started, this is its *first* turn. That creates the worktree and runs title + description as the prompt, and your `text` is ignored. **`202 {queued: true}`**: a turn is already running, and your message runs as the next turn.
- A message also clears an autopilot block (`blocked_reason`) and resets its retry budget. That is how a stuck task gets unstuck.
- The reply is not in the POST response. Re-read `GET tasks/<id>` later, and check `running` (1 means still working) and the newest `assistant` messages.
- `awaiting_input: 1` means the session is waiting on the user. A `tool` message whose content holds `"ask": {"id": "ask-…", "questions": [...]}` with no `answers` is an open question card. Answer it with `/answer`, one array of option labels per question. `{resolved: false}` means nothing was parked, so send the answer as a normal message instead.
- `PATCH` with `status: "cancelled"` **kills the in-flight turn**. Confirm with the user first. The worktree is kept.

## Rules

- Messages run real agent turns, which cost money and change code. Send them when the user asks you to. Don't send speculative "status?" pings, because reading `GET tasks/<id>` answers status for free.
- Quote what you send. A session sees only its own transcript, so write the prompt so it stands alone: name the files, the decision, and what to do. Don't write "as discussed".
- Delete, merge, ship and creating projects are not on this surface. Send those to the UI.
- `HTTP 404` with a non-JSON body means the instance runs a build without these routes. Rebuild it.
