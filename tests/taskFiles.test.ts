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
