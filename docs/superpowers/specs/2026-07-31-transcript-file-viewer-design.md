# Transcript File Viewer — Design

**Date:** 2026-07-31
**Status:** Approved by spec review — awaiting author sign-off

## Problem

Files an agent creates inside the container have no clean route out. A generated
`.sql` migration that the user needs to paste into a separate web console is
visible only as a diff in the transcript — carrying `+`/`-` markers and line
prefixes that corrupt a copy-paste — or as a patch in the diff panel. Neither is
the file's actual contents.

Nor is what the transcript holds complete. For a `Write`, the stored payload is
the rendered diff, capped by `capDiff` at `DIFF_MAX = 400` lines
(`lib/agents/shared.ts:118-122`); the tool result itself is only a success
string. For a `Read`, the result is capped by `clip(raw, 6000)` at the driver
call site (`lib/agents/claude/driver.ts:264`). Either way, for anything long the
transcript never held the whole file, so selecting text on screen silently
yields a partial document. For SQL that is actively dangerous: a truncated
statement may still execute.

The container has no file manager, and `/api/fs` lists directories only
(`app/api/fs/route.ts:35`), so there is no way to read a file's raw contents
from the UI.

## Goals

- Read the complete, unmodified contents of a file an agent wrote, from the transcript.
- Copy those contents to the clipboard in one action.
- Download the file to the local machine.
- Work on mobile, since the instance is reached from a phone via the tunnel.

### What "the file" means

The endpoint serves the file's **current contents on disk**, not a snapshot of
what the agent wrote at that moment. Opening the affordance on an early `Write`
shows the result of any later `Edit`s, and after a worktree is pruned (below) the
contents come from the repository copy, which may have absorbed later merges.
This is the right behaviour for the use case — the user wants the file as it now
stands, to paste elsewhere — but the viewer is explicitly not a historical
record of the write. The pruned case says so in the UI.

## Non-goals

Explicitly out of scope, and not to be added speculatively:

- A file tree or workspace browser.
- Editing, creating, renaming or deleting files. The endpoint is read-only.
- Syntax highlighting. The viewer exists for copying, not for reading code.
- Detecting files produced by shell commands rather than tool calls.
- Serving files for any project or path not associated with a task.
- **Codex tasks.** File paths reach the transcript through `describeToolUse`
  (`lib/agents/shared.ts`), which only the Claude driver calls. The Codex driver
  builds tool events via `describeFileChange`
  (`lib/agents/codex/events.ts:170-182`), which collapses N changes into a single
  event (`✎ Edited 3 files`, with `detail` a newline-joined path list). A
  singular `file` field does not fit that shape: supporting Codex would need a
  `files[]` field and a per-path affordance, which is a separate piece of work,
  not a one-line addition.

## Design

### Data flow

1. `describeToolUse` already derives the absolute path for `Write`, `Edit`,
   `NotebookEdit` and `Read` (`lib/agents/shared.ts:160`) and currently discards
   it into `detail`. It gains an explicit `file` field.

   `file` duplicates `detail` exactly for these four tools. The duplication is
   deliberate: `detail` is the *command* for `Bash` and the *pattern* for `Grep`,
   so the client would otherwise have to infer "is this a file?" from the
   emoji-prefixed `title`, which is far more brittle than carrying the path
   explicitly.

2. The field must be threaded through **eight edit points — five object literals
   and three type declarations**. Every literal is built field-by-field, so an
   omitted edit drops the field silently at runtime rather than failing to
   compile where it was lost.

   > **As built:** the last two rows below were the same literal written twice,
   > so review replaced them with a single shared `toolData(ev)` helper in
   > `lib/types.ts`. That removes the drop-a-field failure mode at those sites
   > rather than relying on care, which is why the count is eight, not nine.

   | Site | Kind |
   |---|---|
   | `lib/agents/shared.ts:159` — `describeToolUse` return annotation | type |
   | `lib/agents/shared.ts:163-171` — `Write` return | literal |
   | `lib/agents/shared.ts:179` — `Edit`/`NotebookEdit` return | literal |
   | `lib/agents/shared.ts:182` — `Read` return | literal |
   | `lib/agents/claude/driver.ts:246-248` — destructure + `tool` event push | literal |
   | `lib/types.ts:202` — `StreamEvent`'s `tool` variant | type |
   | `lib/types.ts:270-287` — `ToolData`, the persisted shape | type |
   | `lib/runner.ts:252` — server-side persistence | literal |
   | `app/orchestrator/useTaskStream.ts:101` — client-side reconstruction | literal |

   `ToolData` is the one that matters most: the UI renders from `ToolData`
   parsed out of `messages.content`, never from the live event, so omitting it
   means no links anywhere. Omitting `useTaskStream.ts` instead means links
   appear only after a page reload.

3. No database migration. Tool events are stored as `JSON.stringify(data)` in
   the `messages.content` TEXT column (`lib/db.ts:85`). Messages written before
   this change lack the field and render as they do today.

### Units

#### `resolveTaskFile` — `lib/taskFiles.ts` (new)

The security boundary, isolated from HTTP so it can be tested directly.

```ts
type Resolved =
  | { ok: true; abs: string; root: string; fromRepoFallback: boolean }
  | { ok: false; reason: "no-root" | "outside-root" | "not-found" | "not-a-file" | "pruned" };

function resolveTaskFile(worktreePath: string, repoPath: string, requested: string): Resolved
```

It takes plain strings rather than `Task` and `Project` objects, matching
`lib/git.ts` (`ensureWorktree(repoPath, taskId)`) and keeping
`tests/taskFiles.test.ts` fixture-free — `Task` has 27 fields and no test helper
builds one. The route passes `task.worktree_path` and `project.repo_path`.

`abs` is the **post-`realpath`** path, so the route reads exactly what was
validated, which **narrows** the check-then-read window — it does not close it,
since any component can still be re-symlinked between the resolver's `realpath`
and the route's `stat`/`read`. That residual race grants nothing: the server and
the agent both run as uid 1000 (`Dockerfile`, `USER orch`), so an agent able to
win it can simply read the secret directly, as the threat-model note below says.
The response's `name` is the basename of
the *requested* path, so the download filename matches what the user clicked.
`root` exists so tests can assert which root was chosen. `fromRepoFallback` is
true whenever a successful resolution came from `repoPath` **because the
workspace was pruned** — not only on the re-anchor branch, since a path recorded
as repo-absolute resolves without re-anchoring and would otherwise omit the note.

Behaviour, in order:

1. **Choose the root.** `worktreePath` is `""` when a task ran directly in the
   repo — non-git or commitless projects, where `ensureWorktree` returned `null`
   (`lib/types.ts:49`, `lib/git.ts:123`). So:
   - `worktreePath` non-empty and the directory exists → that is the root.
   - `worktreePath` non-empty and the directory is **missing** → root is
     `repoPath`, and the resolution is flagged *pruned*. Pruning leaves a stale
     value in the database; the same `existsSync` staleness check is already
     used at `app/api/tasks/[id]/messages/route.ts:102`.
   - `worktreePath` empty → root is `repoPath`, **not** flagged pruned. The task
     never had a workspace, so reporting one as cleaned up would be false.

   If the chosen root does not exist, return `no-root`.

2. **Re-anchor a pruned path.** Worktrees live outside the repo, under
   `ORCH_WORKTREES_DIR` (`lib/git.ts:10-12,125`), and the agent runs with
   `cwd: task.worktree_path || project.repo_path`
   (`lib/agents/claude/driver.ts:161`), so recorded paths are worktree-absolute.
   After pruning, such a path is not under `repo_path` and would fail
   containment. So when *pruned* and `requested` is contained by the stale
   `worktreePath` — using the same containment predicate as step 3, not a bare
   `startsWith`, so that `…/worktrees/abc` does not match `…/worktrees/abc-evil/x`
   — rewrite it as
   `path.resolve(repoPath, path.relative(worktreePath, requested))`.

   Without this, every file from a pruned task reports "outside the workspace",
   and a file that *was* merged into the repo stays unreachable though it exists.

3. **Lexical containment.** Resolve with `path.resolve(root, requested)` — so a
   relative path resolves against the root, not the server's working directory —
   and reject anything not contained as `outside-root`, **without touching the
   filesystem**. Checking before any filesystem access is what stops the endpoint
   acting as an existence oracle for paths outside the root.

4. **Real containment.** `fs.realpathSync` the root and the candidate and
   re-check containment; a mismatch is `outside-root`. `realpathSync` throws
   `ENOENT` for a missing path, so `not-found` — or `pruned`, when step 1 flagged
   it — comes out of that catch rather than a separate `existsSync` pre-check,
   which would add a TOCTOU window for nothing. **Any other resolve error**
   (`EACCES`, `ELOOP`, `ENOTDIR`) also returns `not-found`; the function never
   throws.

5. **Type check.** `fs.statSync`; a directory returns `not-a-file`.

Containment holds only when the resolved path equals the resolved root or begins
with the resolved root plus `path.sep`.

Resolving symlinks before comparing hardens the query-string surface against
traversal and against symlinks that legitimately exist in a checkout. It is not
containment against the agent itself: an agent that can plant a symlink can
equally hardlink or copy a secret into the worktree, and `realpath` does not see
hardlinks. The threat closed here is a crafted `?path=`, not a hostile agent.

#### `GET /api/tasks/[id]/file` — `app/api/tasks/[id]/file/route.ts` (new)

Query parameters: `path` (required), `download` (optional, `1`).

Authentication is enforced upstream by the Access middleware (`middleware.ts`
declares no `matcher` — "No `matcher` config on purpose", line 6 — so it gates
every route); this route adds none of its own.

Success (`200`):

```json
{ "name": "0003_add_scores.sql", "path": "/abs/path", "size": 20480,
  "viewable": true, "downloadable": true, "fromRepoFallback": false, "content": "…" }
```

Readable but not renderable (`200` — still a success):

```json
{ "name": "assets.tar.gz", "path": "/abs/path", "size": 90000000,
  "viewable": false, "downloadable": false, "fromRepoFallback": false,
  "reason": "too-large" }
```

The two flags are computed independently and deterministically:
`viewable = size <= INLINE_MAX && !binary`; `downloadable = size <= DOWNLOAD_MAX`.
`reason` is `"too-large"` when `size > INLINE_MAX`, otherwise `"binary"` — size
is tested first, so an oversized binary reports `"too-large"`.

Failure bodies carry both a human string and a machine-readable reason:

```json
{ "error": "This file is outside the task's workspace, so it can't be opened here.",
  "reason": "outside-root" }
```

`error` matches the repo convention (`app/api/tasks/[id]/uploads/[file]/route.ts:23`).
`FileViewer` calls `fetch` directly rather than the `jget` helper: `fail()`
(`app/orchestrator/api.ts:6-14`) parses the body but throws only `j.error`,
discarding `reason`, and the viewer switches on `reason`.

Contents are **never truncated**. A file over the inline limit is reported
`viewable: false` rather than partially returned — silent truncation is the
defect this feature exists to remove.

With `download=1` the body is the raw bytes and the headers are:

- `Content-Type: application/octet-stream` — never sniffed. Serving
  attacker-influenced content as `text/html` would be a stored-XSS vector on the
  app's own origin.
- `X-Content-Type-Options: nosniff`.
- `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<pct>`.
  Filenames are agent-chosen, so the quoted form is the basename with `"`, `\`,
  control characters and non-ASCII replaced by `_`, and the RFC 5987 `filename*`
  form carries the real name percent-encoded. Basename-only handles paths; this
  handles header-hostile characters.

Limits:

- `INLINE_MAX` = 512 KB. Larger than anything a human hand-copies, small enough
  for a phone to render in one `<pre>`. Size comes from `fs.stat` **before**
  reading, so an over-limit file is never read into memory.
- `DOWNLOAD_MAX` = 25 MB, returning `413`. Files are read into memory, so an
  unbounded read risks the container's memory cap.
- Binary detection: a `NUL` byte **anywhere in the buffer**. An 8 KB window was
  specced originally and is wrong here: that heuristic belongs to *streaming*
  sniffers that haven't read the rest yet, whereas this buffer is the whole file
  already, capped at `INLINE_MAX`. A late NUL slipped through into
  `toString("utf8")` and came back corrupted with U+FFFD — silent corruption in
  a feature whose premise is removing it. `tests/taskFileRoute.test.ts` pins it.

#### `FileViewer` — `app/orchestrator/FileViewer.tsx` (new)

```ts
function FileViewer({ taskId, path, onClose }: { taskId: string; path: string; onClose: () => void })
```

Built on the existing `Modal`, already mobile-sized via `.app.mobile .modal`
(`globals.css:1313`; `.app.mobile` is set on an ancestor at
`app/Orchestrator.tsx:370` and `Modal` is not portaled, so the selector reaches
it). Renders contents in a `<pre>` in a scrolling container. Reuses the existing
`Icon.doc` and `Icon.copy` (`app/icons.tsx:46,54`).

While the fetch is in flight the modal shows the repo's existing `Skel`
placeholder — a 512 KB file over a phone tunnel is not instant. The new icon
button carries a `title` and `aria-label` ("Open file"), matching the
`msg-nav-btn` and `queued-x` buttons.

States, evaluated **in this order** so they are mutually exclusive — a 40 MB file
matches both "too-large" and "not downloadable", and the download verdict wins:

| # | Condition | Body | Copy | Download |
|---|---|---|---|---|
| 1 | non-OK response | copy for the returned `reason` (see Error handling) | hidden | hidden |
| 2 | `downloadable: false` | "This file is 40 MB — too large to show or download from here. Use the project terminal." | hidden | disabled |
| 3 | `viewable: false`, `reason: "too-large"` | "This file is 610 KB — too large to show here. Download it instead." | hidden | enabled |
| 4 | `viewable: false`, `reason: "binary"` | "This looks like a binary file. Download it instead." | hidden | enabled |
| 5 | `viewable: true` | file contents | enabled | enabled |

When `fromRepoFallback` is true, rows 3–5 additionally show a one-line note:
"This task's workspace was cleaned up — showing the repository's copy."

Copy uses `navigator.clipboard.writeText`, matching `Services.tsx:42` and
`github.tsx:86`, with the transient "Copied" confirmation of
`SessionRail.tsx:45`. Unlike those three call sites it must **not** swallow
failure — all three currently do — because `navigator.clipboard` is undefined
outside a secure context and can be blocked by policy, and copying is the
feature's primary goal. On failure the viewer selects the `<pre>` contents via
`window.getSelection` and shows "Copy failed — text selected, press Ctrl/Cmd+C".

Download is a **button, not an anchor**: it fetches `download=1` and renders a
non-OK response as an error inside the modal, instead of navigating the browser
to an error page — which is what an anchor does when the file vanished between
opening the viewer and clicking. On success it creates an object URL, triggers
the download, and revokes the URL.

#### `MessageView` / `ToolView` / `SessionView` — modified

There is no `Transcript` component: `app/orchestrator/Transcript.tsx` exports
`MessageView` and `SessionBreak`, and the render chain is
`SessionView → MessageView → ToolView`.

The filename is not a separate element today: it is baked into `data.title`
(`✎ Write 0003_add_scores.sql`) and rendered in `<span className="tg">`
**inside** `<button className="tool-h">`, whose onClick toggles expansion
(`Transcript.tsx:57-87`). Making the filename a button would nest a button in a
button.

Instead the header gains a sibling icon button. `.tool` is a plain block
(`globals.css:804`) and `.tool-h` is `display:flex; width:100%`
(`globals.css:805`), so a bare sibling renders *below* the header. The change is:

- Wrap the header and the new button in `<div className="tool-row">`.
- Add to `globals.css`:
  `.tool-row { display: flex; align-items: center; gap: 4px; padding-right: 8px }`
  and `.tool-row > .tool-h { flex: 1; min-width: 0 }`. The right padding matters
  because `.tool-h` carries its own `padding: 8px 12px`, so the new button would
  otherwise sit flush against the container edge.
- `PeekView` stays a direct child of `.tool`, so it still renders below the row.

`ToolView` takes only `data: ToolData` and `MessageView` has no task context
(`Transcript.tsx:57,174`). Rather than thread `taskId` down, the modal state is
lifted to `SessionView`, which already holds `task`. An
`onOpenFile?: (path: string) => void` callback is threaded
`SessionView → MessageView → ToolView`; `SessionView` holds
`const [filePath, setFilePath] = useState<string | null>(null)` and mounts
`<FileViewer taskId={task.id} path={filePath} onClose={…} />` when set. The win
is the single mount point and no task id in the transcript tree — the callback
traverses the same two layers a `taskId` prop would.

`MessageView` is rendered at two call sites: `SessionView.tsx:248` (the
transcript) and `:258` (queued-message bubbles). Only `:248` passes
`onOpenFile`; queued bubbles have no tool calls.

`Read` calls get the affordance as well as `Write`, `Edit` and `NotebookEdit`.
`Read` frequently targets paths outside the task root — `~/.claude/CLAUDE.md`,
sibling repos, caches — which `resolveTaskFile` correctly refuses; those report
`outside-root` distinctly rather than as a missing file, since telling the user
a file that plainly exists is "no longer available" would be a lie. If the extra
affordances read as clutter in practice, the fix is to omit them for `Read`.

## Error handling

| Condition | Server | UI copy |
|---|---|---|
| `path` missing or empty | `400` | "No file path on this tool call" |
| Unknown task or project | `404` | "File is no longer available" |
| `no-root` | `404` | "File is no longer available" |
| `not-found` | `404` | "File is no longer available" |
| `pruned` (workspace cleaned up, file not in the repo) | `404` | "This task's workspace was cleaned up, and the file wasn't merged into the repo" |
| `not-a-file` (directory, FIFO, socket or device) | `404` | "That path isn't a regular file" |
| `outside-root` | `404` | "This file is outside the task's workspace, so it can't be opened here" |
| Over `DOWNLOAD_MAX` on a download request | `413` | "File is too large to download" |
| Read fails (permissions, I/O) | `404` | "File is no longer available" |
| Clipboard unavailable or blocked | — | "Copy failed — text selected, press Ctrl/Cmd+C" |

Every failure is `404` apart from a missing parameter and an oversized download.
`outside-root` being distinguishable from `not-found` leaks nothing: containment
is evaluated lexically before any filesystem access, so the endpoint never
discloses whether a path outside the root exists. Within the root, existence is
information the user already has.

## Testing

**`tests/toolDescriptor.test.ts`** (new) — `describeToolUse` is the origin of
the field and currently has **no test coverage at all** (its only caller is
`lib/agents/claude/driver.ts:246`). Four assertions, one per tool, that
`describeToolUse(tool, { file_path }).file` is the path — for `Write`, `Edit`,
`NotebookEdit` and `Read` — plus a negative assertion that **`Grep`** yields no
`file`. `Grep` is the right negative case, not `Bash`: `Bash` carries none of
`file_path`/`path`/`notebook_path`, so it yields `undefined` under almost any
wrong implementation, whereas `Grep` and `Glob` do carry `path` (a *directory*).
A regression that hoists `file` out of the per-tool branches would therefore put
a file affordance on every search, opening a directory — user-visible, and only
this assertion catches it.

**`tests/taskFiles.test.ts`** (new) — `resolveTaskFile` against a temporary
directory. Containment is the only logic here that fails dangerously rather than
visibly:

- A file inside the root resolves successfully.
- The root itself, requested directly, is contained (the `abs === root` branch).
- A `..` sequence escaping the root is rejected as `outside-root`.
- An absolute path outside the root is rejected as `outside-root`.
- A symlink inside the root pointing outside it is rejected — the case a naive
  prefix check passes.
- A relative path resolves against the root, not the process working directory.
- A directory inside the root returns `not-a-file`.
- Stale `worktree_path`: the root falls back to `repo_path`, a worktree-absolute
  path is re-anchored and found, and `fromRepoFallback` is true.
- Stale `worktree_path` with no such file in the repo returns `pruned`, not
  `outside-root`.
- Empty `worktree_path` (never isolated) with a missing file returns
  `not-found`, **not** `pruned`.

**`tests/agentDriver.test.ts`** (existing, optionally extended) — this suite
mocks the driver out entirely (`vi.mock("@/lib/agents/claude/driver")`) and
feeds `lib/runner.ts` a scripted `StreamEvent[]`; its tool assertion at `:194`
is on a `Bash` call. It therefore cannot exercise `describeToolUse` or the
driver hop. Adding `file` to the scripted event and its `toMatchObject` covers
exactly one hop — `runner.ts:252` copying the field into `ToolData` — which is
worth the one line, but must not be mistaken for end-to-end coverage of the
eight edit points.

**As built, `tests/taskFileRoute.test.ts` also exists** — the route turned out
not to be pure glue. Size policy, binary detection and `Content-Disposition`
construction live only there, so seven cases cover them: `disposition()` against
`"`, `\` and CRLF; a NUL past the first 8 KB; the inline gate at both 512 KB and
512 KB + 1 (either alone cannot distinguish `>` from `>=`); and the `download=1`
round-trip. `disposition` is exported solely for that test.

The repo runs vitest via `npm test`.

## Rollout

No migration, no configuration, no feature flag. The field is additive and the
UI degrades to current behaviour when it is absent.
