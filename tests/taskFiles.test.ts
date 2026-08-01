import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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

  // A bare `p.startsWith(root)` in contains() passes every other test here, and
  // is an arbitrary-file-read: root ".../wt" would admit ".../wt-evil/secret".
  it("rejects a sibling directory sharing the root's name prefix", () => {
    const base = tmpDir("base-");
    const wt = path.join(base, "wt");
    fs.mkdirSync(wt);
    writeFile(path.join(base, "wt-evil"), "secret.txt", "s");
    expect(resolveTaskFile(wt, "", path.join(base, "wt-evil/secret.txt")))
      .toMatchObject({ ok: false, reason: "outside-root" });
  });

  // The other tests all point at files that EXIST, so they cannot see the
  // lexical check being dropped or moved after the realpath block -- either
  // turns `reason` into an existence oracle for paths outside the root.
  it("reports outside-root without touching the filesystem", () => {
    const wt = tmpDir("wt-");
    expect(resolveTaskFile(wt, "", "/etc/no-such-file-xyz"))
      .toMatchObject({ ok: false, reason: "outside-root" }); // not "not-found"
  });

  it("refuses a FIFO, which would otherwise block the reader forever", () => {
    const wt = tmpDir("wt-");
    try {
      execFileSync("mkfifo", [path.join(wt, "pipe")]);
    } catch {
      return; // mkfifo needs a POSIX host
    }
    expect(resolveTaskFile(wt, "", path.join(wt, "pipe")))
      .toMatchObject({ ok: false, reason: "not-a-file" });
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

  // Root reached via a symlink (/var -> /private/var on macOS): a request in the
  // real form is plainly inside the workspace and must not read as an escape.
  it("accepts a file under a symlinked root expressed in real form", () => {
    const base = tmpDir("base-");
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    writeFile(real, "a.txt", "hi");
    try {
      fs.symlinkSync(real, path.join(base, "link"));
    } catch {
      return; // symlink creation needs privilege on some Windows setups
    }
    expect(resolveTaskFile(path.join(base, "link"), "", path.join(real, "a.txt")))
      .toMatchObject({ ok: true });
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
    if (r.ok) {
      expect(fs.readFileSync(r.abs, "utf8")).toBe("select 2;");
      expect(r.root).toBe(fs.realpathSync(repo)); // re-anchored onto the repo
    }
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
