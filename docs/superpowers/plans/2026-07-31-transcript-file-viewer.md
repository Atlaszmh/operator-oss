# Transcript File Viewer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open, copy and download the full contents of a file an agent wrote, from the transcript.

**Architecture:** `describeToolUse` already computes the absolute path for `Write`/`Edit`/`NotebookEdit`/`Read` and discards it into `detail`; we surface it as an explicit `file` field and thread it through to the persisted `ToolData`. A new read endpoint resolves that path against the task's worktree with strict containment, and a modal renders it with Copy and Download.

**Tech Stack:** Next.js App Router (route handlers), React 19 client components, node `fs`/`path`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-transcript-file-viewer-design.md`

**Branch:** `transcript-file-viewer` — created, but **not** currently checked out. Task 0 handles that.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/taskFiles.ts` (new) | Path resolution + containment. Pure, HTTP-free, the security boundary. |
| `app/api/tasks/[id]/file/route.ts` (new) | HTTP concerns: params, size/binary policy, JSON vs download response. |
| `lib/agents/shared.ts` (modify) | `describeToolUse` returns `file`. |
| `lib/types.ts` (modify) | `file` on `StreamEvent`'s `tool` variant and on `ToolData`. |
| `lib/agents/claude/driver.ts` (modify) | Pass `file` into the pushed tool event. |
| `lib/runner.ts` (modify) | Persist `file` into `ToolData`. |
| `app/orchestrator/useTaskStream.ts` (modify) | Rebuild `ToolData` with `file` client-side. |
| `app/orchestrator/FileViewer.tsx` (new) | The modal: fetch, render, Copy, Download. |
| `app/orchestrator/Transcript.tsx` (modify) | The affordance on the tool row; `onOpenFile` prop. |
| `app/orchestrator/SessionView.tsx` (modify) | Owns the modal state and mounts `FileViewer`. |
| `app/globals.css` (modify) | `.tool-row` / `.tool-file` rules. |
| `tests/taskFiles.test.ts` (new) | Containment tests. |
| `tests/toolDescriptor.test.ts` (new) | `describeToolUse` returns `file` per tool. |

---

## Chunk 1: Path containment and the read endpoint

### Task 0: Branch and toolchain

**Nothing below can be verified until this is done.** `npm ci` **fails natively
on this Windows machine** with a node-gyp error — the native modules
(`better-sqlite3`, `node-pty`) have no build toolchain here, which is why the app
itself runs in Docker. `node_modules` may already be present from an earlier
measurement run, but it is **Linux**-built, so vitest and tsc can only be run
inside a container. Step 3 is idempotent either way.

- [ ] **Step 1: Check out the feature branch**

The branch exists but is **not** checked out — HEAD is on
`subscription-usage-panel`, so without this every commit below lands on the
wrong branch.

```bash
cd /c/Projects/operator-oss
git checkout transcript-file-viewer
git status -sb
```

Expected: `## transcript-file-viewer`.

- [ ] **Step 2: Define the verification helper**

Every `orun "…"` in this plan means "run this in a Node 22 container with the
repo mounted". In **PowerShell**:

```powershell
function orun { docker run --rm -v "C:\Projects\operator-oss:/app" -w /app node:22-bookworm sh -c $args }
```

Use PowerShell, not Git Bash: MSYS rewrites `/app` to `C:/Program Files/Git/app`
and docker rejects it. If you must use Git Bash, prefix with `MSYS_NO_PATHCONV=1`.

- [ ] **Step 3: Install dependencies (once)**

```powershell
orun "npm ci --no-audit --no-fund"
```

Expected: `added 345 packages`, ~2 minutes. This writes **Linux** `node_modules`
into the Windows checkout, which is correct here — a native install is
impossible anyway — but means you cannot later run these tools outside the
container.

- [ ] **Step 4: Record the baseline before changing anything**

```powershell
orun "npx tsc --noEmit; npm test"
```

Expected, on an unmodified tree:

- **`tsc` reports exactly 3 errors**, all in `tests/services.test.ts` lines
  98-100 (`Property 'NODE_ENV' is missing in type … ProcessEnv`). These are
  **pre-existing and unrelated to this feature**. Do not fix them, and do not
  read them as damage you caused. Any *other* error is yours.
- **`npm test`: 33 files, 243 tests, all passing**, ~110s.

Both numbers are the gate for every later verification step: the suite must
still be green, and `tsc` must report those same 3 errors and no more.

---

### Task 1: `resolveTaskFile`

**Files:**
- Create: `lib/taskFiles.ts`
- Test: `tests/taskFiles.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/taskFiles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpDir, writeFile } from "./helpers";
import { resolveTaskFile } from "@/lib/taskFiles";

describe("resolveTaskFile", () => {
  it("resolves a file inside the root", () => {
    const wt = tmpDir("wt-");
    writeFile(wt, "a/b.sql", "select 1;");
    const r = resolveTaskFile(wt, "", path.join(wt, "a/b.sql"));
    expect(r).toMatchObject({ ok: true, fromRepoFallback: false });
    if (r.ok) expect(fs.readFileSync(r.abs, "utf8")).toBe("select 1;");
  });

  it("treats the root itself as contained but not a file", () => {
    const wt = tmpDir("wt-");
    expect(resolveTaskFile(wt, "", wt)).toMatchObject({ ok: false, reason: "not-a-file" });
  });

  it("rejects a .. escape", () => {
    const wt = tmpDir("wt-");
    const outside = tmpDir("out-");
    writeFile(outside, "secret.txt", "s");
    const rel = path.relative(wt, path.join(outside, "secret.txt"));
    expect(resolveTaskFile(wt, "", rel)).toMatchObject({ ok: false, reason: "outside-root" });
  });

  it("rejects an absolute path outside the root", () => {
    const wt = tmpDir("wt-");
    const outside = tmpDir("out-");
    writeFile(outside, "secret.txt", "s");
    expect(resolveTaskFile(wt, "", path.join(outside, "secret.txt")))
      .toMatchObject({ ok: false, reason: "outside-root" });
  });

  it("rejects a symlink inside the root that points outside it", () => {
    const wt = tmpDir("wt-");
    const outside = tmpDir("out-");
    writeFile(outside, "secret.txt", "s");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(wt, "link.txt"));
    } catch {
      return; // symlink creation needs privilege on some Windows setups
    }
    expect(resolveTaskFile(wt, "", path.join(wt, "link.txt")))
      .toMatchObject({ ok: false, reason: "outside-root" });
  });

  it("resolves a relative path against the root, not process.cwd()", () => {
    const wt = tmpDir("wt-");
    writeFile(wt, "note.txt", "hi");
    expect(resolveTaskFile(wt, "", "note.txt")).toMatchObject({ ok: true });
  });

  it("reports a directory as not-a-file", () => {
    const wt = tmpDir("wt-");
    fs.mkdirSync(path.join(wt, "sub"));
    expect(resolveTaskFile(wt, "", path.join(wt, "sub")))
      .toMatchObject({ ok: false, reason: "not-a-file" });
  });

  it("re-anchors onto the repo when the worktree was pruned", () => {
    const repo = tmpDir("repo-");
    const goneWt = path.join(tmpDir("wtroot-"), "pruned");
    writeFile(repo, "db/x.sql", "select 2;");
    const r = resolveTaskFile(goneWt, repo, path.join(goneWt, "db/x.sql"));
    expect(r).toMatchObject({ ok: true, fromRepoFallback: true });
    if (r.ok) expect(fs.readFileSync(r.abs, "utf8")).toBe("select 2;");
  });

  it("reports pruned (not outside-root) when the file never reached the repo", () => {
    const repo = tmpDir("repo-");
    const goneWt = path.join(tmpDir("wtroot-"), "pruned");
    expect(resolveTaskFile(goneWt, repo, path.join(goneWt, "db/x.sql")))
      .toMatchObject({ ok: false, reason: "pruned" });
  });

  it("does not claim 'pruned' for a task that never had a worktree", () => {
    const repo = tmpDir("repo-");
    expect(resolveTaskFile("", repo, path.join(repo, "missing.txt")))
      .toMatchObject({ ok: false, reason: "not-found" });
  });

  it("returns no-root when neither root exists", () => {
    expect(resolveTaskFile("", path.join(tmpDir("x-"), "nope"), "a.txt"))
      .toMatchObject({ ok: false, reason: "no-root" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `orun "npm test -- taskFiles"`
Expected: FAIL — cannot resolve `@/lib/taskFiles`.

- [ ] **Step 3: Implement**

Create `lib/taskFiles.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

export type Resolved =
  | { ok: true; abs: string; root: string; fromRepoFallback: boolean }
  | { ok: false; reason: "no-root" | "outside-root" | "not-found" | "not-a-file" | "pruned" };

/** `p` is `root` itself or lives beneath it. Both must already be absolute. */
function contains(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a caller-supplied path to a file inside a task's workspace.
 *
 * This is a trust boundary: the container holds ~/.claude/.credentials.json and
 * project .env.local files, so an unbounded read here would be an arbitrary-file
 * -read vulnerability. Takes plain strings (not Task/Project) so it can be
 * tested without fixtures, matching lib/git.ts.
 */
export function resolveTaskFile(worktreePath: string, repoPath: string, requested: string): Resolved {
  // A task that ran directly in the repo has worktree_path === "" — which is NOT
  // the same as one whose worktree was pruned, and must not be reported as such.
  const pruned = !!worktreePath && !isDir(worktreePath);
  const root = worktreePath && !pruned ? worktreePath : repoPath;
  if (!root || !isDir(root)) return { ok: false, reason: "no-root" };

  // Worktrees live outside the repo (ORCH_WORKTREES_DIR), so a recorded
  // worktree-absolute path is not under repoPath once the worktree is gone.
  // Re-anchor it, or every file from a pruned task reads as "outside the
  // workspace" and merged files stay unreachable.
  let want = requested;
  if (pruned && path.isAbsolute(requested)) {
    const oldRoot = path.resolve(worktreePath);
    const abs = path.resolve(requested);
    if (contains(oldRoot, abs)) want = path.resolve(repoPath, path.relative(oldRoot, abs));
  }

  // Containment is checked lexically BEFORE any filesystem access, so the
  // endpoint cannot be used to probe whether a path outside the root exists.
  const absRoot = path.resolve(root);
  const lex = path.resolve(absRoot, want);
  if (!contains(absRoot, lex)) return { ok: false, reason: "outside-root" };

  // realpathSync throws ENOENT for a missing path, so not-found falls out of the
  // catch — an existsSync pre-check would only add a TOCTOU window. Any other
  // resolve error (EACCES/ELOOP/ENOTDIR) is reported the same way.
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = fs.realpathSync(absRoot);
    realAbs = fs.realpathSync(lex);
  } catch {
    return { ok: false, reason: pruned ? "pruned" : "not-found" };
  }
  // Re-check after resolving: this is what stops a symlink inside the worktree
  // that points at a secret outside it.
  if (!contains(realRoot, realAbs)) return { ok: false, reason: "outside-root" };

  if (isDir(realAbs)) return { ok: false, reason: "not-a-file" };

  return { ok: true, abs: realAbs, root: realRoot, fromRepoFallback: pruned };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `orun "npm test -- taskFiles"`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/taskFiles.ts tests/taskFiles.test.ts
git commit -s -m "Resolve a task file path, refusing anything outside the workspace"
```

---

### Task 2: The read endpoint

**Files:**
- Create: `app/api/tasks/[id]/file/route.ts`

No unit test: the route is thin glue over `resolveTaskFile` (tested) and `fs`. It is verified manually in Task 7.

- [ ] **Step 1: Implement**

Create `app/api/tasks/[id]/file/route.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { resolveTaskFile } from "@/lib/taskFiles";

export const dynamic = "force-dynamic";

const INLINE_MAX = 512 * 1024; // renders in one <pre>, including on a phone
const DOWNLOAD_MAX = 25 * 1024 * 1024; // read into memory — bound it

const COPY: Record<string, string> = {
  "no-root": "File is no longer available.",
  "not-found": "File is no longer available.",
  pruned: "This task's workspace was cleaned up, and the file wasn't merged into the repo.",
  "not-a-file": "That path is a directory.",
  "outside-root": "This file is outside the task's workspace, so it can't be opened here.",
};

/** Every failure is 404 so the endpoint never confirms a path outside the root. */
function fail(reason: string) {
  return NextResponse.json({ error: COPY[reason] ?? COPY["not-found"], reason }, { status: 404 });
}

/** Agent-chosen filenames reach a header here: quoted ASCII + RFC 5987 for the real name. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Read one file from a task's workspace. Auth: middleware (Access JWT). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const requested = (url.searchParams.get("path") ?? "").trim();
  if (!requested) {
    return NextResponse.json({ error: "No file path on this tool call.", reason: "no-path" }, { status: 400 });
  }

  const task = getTask(id);
  if (!task) return fail("not-found");
  const project = getProject(task.project_id);
  if (!project) return fail("not-found");

  const r = resolveTaskFile(task.worktree_path, project.repo_path, requested);
  if (!r.ok) return fail(r.reason);

  let size: number;
  try {
    size = fs.statSync(r.abs).size; // stat before read: never load an over-limit file
  } catch {
    return fail("not-found");
  }

  const downloadable = size <= DOWNLOAD_MAX;
  const name = path.basename(requested);

  if (url.searchParams.get("download") === "1") {
    if (!downloadable) {
      return NextResponse.json({ error: "File is too large to download.", reason: "too-large" }, { status: 413 });
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(r.abs);
    } catch {
      return fail("not-found");
    }
    return new Response(new Uint8Array(buf), {
      headers: {
        // Never a sniffed type: serving agent-authored content as text/html
        // would be a stored-XSS vector on the app's own origin.
        "Content-Type": "application/octet-stream",
        "Content-Disposition": disposition(name),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const base = { name, path: r.abs, size, downloadable, fromRepoFallback: r.fromRepoFallback };

  // Never truncate — silent truncation is the defect this feature removes.
  if (size > INLINE_MAX) return NextResponse.json({ ...base, viewable: false, reason: "too-large" });

  let buf: Buffer;
  try {
    buf = fs.readFileSync(r.abs);
  } catch {
    return fail("not-found");
  }
  if (buf.subarray(0, 8192).includes(0)) {
    return NextResponse.json({ ...base, viewable: false, reason: "binary" });
  }

  return NextResponse.json({ ...base, viewable: true, content: buf.toString("utf8") });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `orun "npx tsc --noEmit"`
Expected: **only the 3 known baseline errors** in `tests/services.test.ts` (see Task 0). Any error naming a file you touched is yours.

- [ ] **Step 3: Commit**

```bash
git add "app/api/tasks/[id]/file/route.ts"
git commit -s -m "Serve one file from a task's workspace, inline or as a download"
```

---

## Chunk 2: Thread the file path to the client

### Task 3: `describeToolUse` returns `file`

**Files:**
- Modify: `lib/agents/shared.ts:159` (return type), `:163-171` (Write), `:179` (Edit/NotebookEdit), `:182` (Read)
- Test: `tests/toolDescriptor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/toolDescriptor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeToolUse } from "@/lib/agents/shared";

// describeToolUse has no other coverage, and `file` is threaded through six
// hand-built object literals — an omitted edit drops it silently at runtime
// rather than failing to compile, so pin it at the source.
describe("describeToolUse file field", () => {
  it("returns the path for Write", () => {
    expect(describeToolUse("Write", { file_path: "/w/a.sql", content: "x" }).file).toBe("/w/a.sql");
  });

  it("returns the path for Edit", () => {
    expect(describeToolUse("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }).file).toBe("/w/a.ts");
  });

  it("returns the path for NotebookEdit", () => {
    expect(describeToolUse("NotebookEdit", { notebook_path: "/w/a.ipynb", old_string: "", new_string: "b" }).file).toBe("/w/a.ipynb");
  });

  it("returns the path for Read", () => {
    expect(describeToolUse("Read", { file_path: "/w/a.md" }).file).toBe("/w/a.md");
  });

  // Grep, not Bash, is the load-bearing negative: Bash carries none of
  // file_path/path/notebook_path so it yields undefined under almost any wrong
  // implementation, whereas Grep carries `path` — a DIRECTORY. Hoisting `file`
  // out of the per-tool branches would put a file affordance on every search.
  it("does not set file for Grep, whose `path` is a directory", () => {
    expect(describeToolUse("Grep", { pattern: "x", path: "/w/src" }).file).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `orun "npm test -- toolDescriptor"`
Expected: **4 failures, 1 pass** — the four positive cases fail because `.file`
is `undefined`; the `Grep` negative asserts `toBeUndefined()` and so passes
before the change. That is correct, not a broken test.

- [ ] **Step 3: Implement**

In `lib/agents/shared.ts`, add `file?: string` to the return type at line 159:

```ts
): { title: string; detail: string; file?: string; peek?: ToolPeek; diff?: DiffLine[]; resultKind?: ResultKind } {
```

Then add `file` to exactly three return sites. `Write`:

```ts
      return {
        title: `✎ Write ${base ?? "file"}`,
        detail: file ?? "",
        file,
        diff: capDiff(diff),
        peek: diffPeek(diff, `Wrote ${plural(diff.length, "line")}${base ? ` to ${base}` : ""}`),
      };
```

`Edit`/`NotebookEdit`:

```ts
      return { title: `✎ Edit ${base ?? "file"}`, detail: file ?? "", file, diff: capDiff(diff), peek: diffPeek(diff) };
```

`Read`:

```ts
      return { title: `📖 Read ${base ?? "file"}`, detail: file ?? "", file, resultKind: "read" };
```

Do **not** hoist `file` into a shared return: `Grep` and `Glob` also populate the
local `file` const from `input.path`, which is a directory.

- [ ] **Step 4: Run to verify it passes**

Run: `orun "npm test -- toolDescriptor"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared.ts tests/toolDescriptor.test.ts
git commit -s -m "Surface the file path describeToolUse already computes"
```

---

### Task 4: Thread `file` to the persisted shape

**Files:**
- Modify: `lib/types.ts:202` (StreamEvent), `lib/types.ts:270-287` (ToolData)
- Modify: `lib/agents/claude/driver.ts:246-248`
- Modify: `lib/runner.ts:252`
- Modify: `app/orchestrator/useTaskStream.ts:101`

- [ ] **Step 1: Add `file` to both types**

`lib/types.ts:202`:

```ts
  | { type: "tool"; id: string; title: string; detail: string; file?: string; peek?: ToolPeek; diff?: DiffLine[] }
```

In `ToolData` (after `detail`):

```ts
  // Absolute path of the file this call wrote or read, when it had one. Powers
  // the transcript's open-file affordance. Absent on messages persisted before
  // that feature, and on tools with no file (Bash, Grep, …).
  file?: string;
```

- [ ] **Step 2: Pass it through the driver**

`lib/agents/claude/driver.ts:246-248`:

```ts
              const { title, detail, file, peek, diff, resultKind } = describeToolUse(block.name, block.input as Record<string, unknown>);
              if (resultKind) resultKinds.set(block.id, resultKind);
              queue.push({ type: "tool", id: block.id, title, detail, file, peek, diff });
```

- [ ] **Step 3: Persist it server-side**

`lib/runner.ts:252`:

```ts
        const data: ToolData = { title: ev.title, detail: ev.detail, file: ev.file, peek: ev.peek, diff: ev.diff };
```

- [ ] **Step 4: Rebuild it client-side**

`app/orchestrator/useTaskStream.ts:101`:

```ts
      const data: ToolData = { title: ev.title, detail: ev.detail, file: ev.file, peek: ev.peek, diff: ev.diff };
```

Missing this one is the subtle failure: links would appear only after a reload,
because the live stream would drop the field while the DB kept it.

- [ ] **Step 5: Verify types and the full suite**

Run: `orun "npx tsc --noEmit; npm test"`
Expected: **only the 3 known baseline errors** in `tests/services.test.ts` (see Task 0), and 243+ tests passing.

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/agents/claude/driver.ts lib/runner.ts app/orchestrator/useTaskStream.ts
git commit -s -m "Carry the file path through to the persisted tool message"
```

---

## Chunk 3: The viewer and its affordance

### Task 5: `FileViewer`

**Files:**
- Create: `app/orchestrator/FileViewer.tsx`

- [ ] **Step 1: Implement**

Create `app/orchestrator/FileViewer.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { Modal } from "./Modal";
import { Skel } from "./shared";

interface FileData {
  name: string;
  path: string;
  size: number;
  viewable: boolean;
  downloadable: boolean;
  fromRepoFallback: boolean;
  reason?: "too-large" | "binary";
  content?: string;
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function FileViewer({ taskId, path, onClose }: { taskId: string; path: string; onClose: () => void }) {
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: a failed download must not blank out file contents
  // that already loaded fine.
  const [dlError, setDlError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const preRef = useRef<HTMLPreElement>(null);

  const src = `/api/tasks/${taskId}/file?path=${encodeURIComponent(path)}`;

  // Plain fetch, not the jget helper: fail() throws only `error` and discards
  // `reason`, which the states below switch on.
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    // Reset the per-file UI state too, or opening a second file without closing
    // the modal carries the previous file's download error and "Copied" flash.
    setDlError(null);
    setCopied("");
    fetch(src)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) setData(j as FileData);
        else setError(j.error || "File is no longer available.");
      })
      .catch(() => { if (live) setError("File is no longer available."); });
    return () => { live = false; };
  }, [src]);

  // Unlike the other clipboard call sites in this app, a failure must NOT be
  // swallowed: navigator.clipboard is undefined outside a secure context, and
  // copying is the whole point of this modal. Fall back to selecting the text.
  const copy = async () => {
    if (!data?.content) return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied("ok");
      setTimeout(() => setCopied(""), 1400);
    } catch {
      const pre = preRef.current;
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopied("fail");
    }
  };

  // A button rather than an anchor: if the file vanished between opening the
  // modal and clicking, an anchor navigates the browser to an error page.
  const download = async () => {
    setDlError(null);
    try {
      const r = await fetch(`${src}&download=1`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setDlError(j.error || "File is too large to download.");
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = data?.name || "file";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDlError("Download failed.");
    }
  };

  // Ordered so the states are mutually exclusive: a file over DOWNLOAD_MAX is
  // both "too-large" and undownloadable, and the download verdict wins.
  const body = () => {
    if (error) return <div className="hlp">{error}</div>;
    if (!data) return <Skel w="100%" h={140} />;
    if (!data.downloadable)
      return <div className="hlp">This file is {fmtSize(data.size)} — too large to show or download from here. Use the project terminal.</div>;
    if (!data.viewable && data.reason === "too-large")
      return <div className="hlp">This file is {fmtSize(data.size)} — too large to show here. Download it instead.</div>;
    if (!data.viewable) return <div className="hlp">This looks like a binary file. Download it instead.</div>;
    return <pre ref={preRef} className="tool-pre" style={{ maxHeight: "60vh", overflow: "auto" }}>{data.content}</pre>;
  };

  const copyLabel = copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed — text selected, press Ctrl/Cmd+C" : "Copy";

  return (
    <Modal
      title={data?.name ?? path.split("/").slice(-1)[0]}
      sub={data?.fromRepoFallback ? "This task's workspace was cleaned up — showing the repository's copy." : path}
      onClose={onClose}
      width={760}
      footer={
        <>
          {data?.viewable && !error && (
            <button className="btn btn-line" onClick={copy}>
              {copied === "ok" ? Icon.check() : Icon.copy()} {copyLabel}
            </button>
          )}
          {data && !error && (
            <button className="btn btn-line" onClick={download} disabled={!data.downloadable}>
              {Icon.doc()} Download
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </>
      }
    >
      {body()}
      {dlError && <div className="hlp" style={{ marginTop: 8 }}>{dlError}</div>}
    </Modal>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `orun "npx tsc --noEmit"`
Expected: **only the 3 known baseline errors** in `tests/services.test.ts` (see Task 0). Any error naming a file you touched is yours.

- [ ] **Step 3: Commit**

```bash
git add app/orchestrator/FileViewer.tsx
git commit -s -m "A modal that shows a file whole, with copy and download"
```

---

### Task 6: The affordance and its wiring

**Files:**
- Modify: `app/orchestrator/Transcript.tsx:57` (`ToolView`), `:174` (`MessageView` props), `:196` (`ToolView` call)
- Modify: `app/orchestrator/SessionView.tsx:248`
- Modify: `app/globals.css` (after the `.tool-h` block ends at line 813)

- [ ] **Step 1: Add the CSS**

Insert after **line 813** — the `.tool-h .tcheck svg,.tool-h .tx svg` rule —
not after the `.tool-h .tx` rule at 812, which would split that selector off
from its own block:

```css
/* file affordance: a sibling of .tool-h, since .tool-h is the expand toggle and
   a button cannot nest inside a button */
.tool-row{display:flex;align-items:center;gap:4px;padding-right:8px;}
.tool-row>.tool-h{flex:1;min-width:0;}
.tool-file{flex:0 0 auto;display:inline-flex;padding:4px;border-radius:5px;color:var(--ink-4);}
.tool-file:hover{color:var(--ink-2);background:var(--panel-2);}
.tool-file svg{width:13px;height:13px;}
/* .tool-h's own hover (line 806) now covers only its shrunken flex box, so the
   highlight would stop short of the new button. Paint the ROW instead, so the
   sweep spans the full width as it did when .tool-h was width:100% */
.tool-row:hover{background:var(--panel-2);}
```

The right padding matters: `.tool-h` carries its own `padding:8px 12px`, so
without it the new button sits flush against the container edge.

- [ ] **Step 2: Wrap the header and add the button**

In `app/orchestrator/Transcript.tsx`, change `ToolView`'s signature and header.
Signature:

```tsx
function ToolView({ data, onOpenFile }: { data: ToolData; onOpenFile?: (path: string) => void }) {
```

Replace the single `<button className="tool-h">…</button>` with:

```tsx
      <div className="tool-row">
        <button className="tool-h" style={{ cursor: expandable ? "pointer" : "default" }} onClick={() => expandable && setOpen((o) => !o)}>
          {expandable && <span className={`tchev ${showBody ? "open" : ""}`}>{Icon.chevRight()}</span>}
          <span className="tg">{data.title}</span>
          {data.result !== undefined && <span className={data.isError ? "tx" : "tcheck"}>{data.isError ? Icon.x() : Icon.check()}</span>}
        </button>
        {data.file && onOpenFile && (
          <button className="tool-file" title="Open file" aria-label="Open file" onClick={() => onOpenFile(data.file!)}>
            {Icon.doc()}
          </button>
        )}
      </div>
```

`PeekView` and the body stay direct children of `.tool`, below the row.

- [ ] **Step 3: Thread the callback through MessageView**

Add `onOpenFile` to `MessageView`'s props (line 174) — both the destructure and
the type — then pass it at the `ToolView` call site (line 196):

```tsx
    return <div className="msg msg-tool"><ToolView data={data} onOpenFile={onOpenFile} /></div>;
```

- [ ] **Step 4: Own the modal state in SessionView**

In `app/orchestrator/SessionView.tsx`, import the viewer:

```tsx
import { FileViewer } from "./FileViewer";
```

Add state alongside the component's other `useState` calls:

```tsx
  const [filePath, setFilePath] = useState<string | null>(null);
```

Pass the callback at the transcript call site (line 248) only — queued-message
bubbles at line 258 have no tool calls:

```tsx
                return <MessageView key={m.id} m={m} initial={mi === 0 && m.role === "user"} hideWho={hideWho} running={running} agent={task.agent} agentLabel={agentLabel(agents, task.agent)} onAnswer={onAnswer} onCancelQueued={onCancelQueued} onClear={onClear} onReconnect={onReconnect} onOpenFile={setFilePath} />;
```

Mount the modal as the **last child inside** the returned `<div className="session">`
(`SessionView.tsx:280-439`). It must go inside: the component returns that single
div, so adding a sibling without wrapping in a fragment is a compile error.
Nesting is harmless — `.scrim` is `position:fixed; z-index:200`
(`globals.css:1039`), so the modal still covers the viewport:

```tsx
      {filePath && <FileViewer taskId={task.id} path={filePath} onClose={() => setFilePath(null)} />}
```

- [ ] **Step 5: Verify types and the full suite**

Run: `orun "npx tsc --noEmit; npm test"`
Expected: **only the 3 known baseline errors** in `tests/services.test.ts` (see Task 0), and 243+ tests passing.

- [ ] **Step 6: Commit**

```bash
git add app/orchestrator/Transcript.tsx app/orchestrator/SessionView.tsx app/globals.css
git commit -s -m "Open a written file straight from its tool call"
```

---

### Task 7: Verify it end to end

The container mounts a named volume, not this working tree, so a rebuild is
required for the change to run.

- [ ] **Step 1: Rebuild and restart**

In PowerShell (the compose file requires these three variables):

```powershell
cd C:\Projects\operator-oss
$env:ORCH_USER="hahnz"; $env:ORCH_PORT="10001"; $env:ORCH_RUNTIME="runc"
docker compose -p orch-hahnz up -d --build
```

Expected: `Container orch-u-hahnz Started`, then `healthy` within ~40s.

- [ ] **Step 2: Drive a real task**

In the UI, send a task a message such as: *"Write a file `demo.sql` containing a
CREATE TABLE statement, then read it back."*

- [ ] **Step 3: Check the four states by hand**

- The `Write` tool row shows a document icon; clicking it opens the modal with
  the complete file, and **Copy** puts the whole thing on the clipboard.
- The `Read` row also shows the icon.
- A `Read` of a path outside the workspace (`~/.claude/CLAUDE.md`) reports
  "This file is outside the task's workspace", **not** "no longer available".
- `Bash` and `Grep` rows show **no** icon.

- [ ] **Step 4: Confirm containment on the live instance**

Requests go through Cloudflare Access, so run these inside the container, where
the origin is reachable without a JWT:

```bash
docker exec orch-u-hahnz sh -c 'curl -s -o /dev/null -w "%{http_code}\n" \
  "http://127.0.0.1:3000/api/tasks/<TASK_ID>/file?path=/home/orch/.claude/.credentials.json"'
```

Expected: `404`. Repeat with `path=` omitted; expected `400`.

- [ ] **Step 5: Commit any fixes, then push**

```bash
git commit -s -am "Fix up the file viewer after manual verification"   # only if Steps 2-4 needed changes
git push -u origin transcript-file-viewer
```
