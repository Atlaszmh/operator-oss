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
