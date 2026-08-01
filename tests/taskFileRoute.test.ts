import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

import { createProject, createTask } from "@/lib/store";
import { GET, disposition } from "@/app/api/tasks/[id]/file/route";
import { tmpDir } from "./helpers";

// resolveTaskFile has its own suite (tests/taskFiles.test.ts), so the resolve-
// and-404 path is not re-tested here. What IS only in the route — the size
// policy, binary detection, and the Content-Disposition header — has no other
// coverage, and is the feature's behavioral contract. Real store, real files,
// no mocking (same seam as tests/taskLock.test.ts).

let repo: string;
let taskId: string;

// worktree_path defaults to "", so resolveTaskFile roots at repo_path — no git
// worktree needed, the resolver only requires the root to be a directory.
beforeAll(() => {
  repo = tmpDir("filerepo-");
  const project = createProject({ name: "files", repo_path: repo });
  taskId = createTask({ project_id: project.id, title: "t" }).id;
});

function write(name: string, content: string | Buffer): string {
  fs.writeFileSync(path.join(repo, name), content);
  return name;
}

function get(query: string) {
  return GET(new Request(`http://x/api/tasks/${taskId}/file?${query}`), { params: Promise.resolve({ id: taskId }) });
}

const fetchFile = (rel: string) => get(`path=${encodeURIComponent(rel)}`);

describe("Content-Disposition escaping", () => {
  // A raw quote would end the filename parameter early and let the rest of the
  // name inject header parameters; a raw CR/LF would split the response. The
  // RFC 5987 filename* still carries the true name for compliant clients.
  it("neutralizes quotes, backslashes and CRLF in the ASCII filename", () => {
    const d = disposition('a"b\\c\r\nd.txt');
    const ascii = /filename="([^"]*)"/.exec(d)![1];
    expect(ascii).toBe("a_b_c__d.txt");
    expect(d).not.toMatch(/[\r\n]/);
    expect(d).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(d.split("filename*=UTF-8''")[1])).toBe('a"b\\c\r\nd.txt');
  });
});

describe("inline read: size and binary gates", () => {
  it("returns the content of a text file", async () => {
    write("hello.txt", "line one\nline two\n");
    const body = await (await fetchFile("hello.txt")).json();
    expect(body).toMatchObject({ name: "hello.txt", viewable: true, content: "line one\nline two\n", downloadable: true });
    // `name` is normalized before basename: a trailing "/." resolves to the same
    // file, and without the normalize would be sent to the browser as ".".
    expect((await (await fetchFile("hello.txt/.")).json()).name).toBe("hello.txt");
  });

  // Regression: the sniff used to scan only the first 8KB, borrowed from
  // STREAMING sniffers where the tail isn't read yet. Here the whole file is
  // already in memory, so a later NUL slipped through into toString("utf8"),
  // which substitutes U+FFFD — silent corruption, and the user's next action is
  // "copy to clipboard".
  it("detects a NUL byte past the first 8KB", async () => {
    write("late-nul.bin", Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]));
    const body = await (await fetchFile("late-nul.bin")).json();
    expect(body.viewable).toBe(false);
    expect(body.reason).toBe("binary");
    expect(body.content).toBeUndefined();
  });

  // Refused whole, never truncated: silent truncation is the defect this
  // feature removes. `downloadable` stays true so the UI can still offer it.
  it("refuses to inline a file over 512KB, without truncating it", async () => {
    const size = 512 * 1024 + 1;
    write("big.txt", Buffer.alloc(size, 0x61));
    const body = await (await fetchFile("big.txt")).json();
    expect(body).toMatchObject({ viewable: false, reason: "too-large", size, downloadable: true });
    expect(body.content).toBeUndefined();
  });

  it("inlines a file exactly at the 512KB limit", async () => {
    write("edge.txt", Buffer.alloc(512 * 1024, 0x61));
    const body = await (await fetchFile("edge.txt")).json();
    expect(body.viewable).toBe(true);
    expect(body.content.length).toBe(512 * 1024);
  });
});

describe("download", () => {
  // Bytes include a NUL: binary is a download-only concern, never a blocker.
  it("serves the exact bytes as an unsniffable attachment", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x42, 0x0a]);
    write("blob.bin", bytes);
    const res = await get(`path=${encodeURIComponent("blob.bin")}&download=1`);
    expect(res.status).toBe(200);
    // Serving agent-authored bytes as a sniffed text/html would be stored XSS
    // on the app's own origin.
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="blob.bin"; filename*=UTF-8''blob.bin`);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });
});
