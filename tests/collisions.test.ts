import { describe, expect, it } from "vitest";
import { branchCollisions, cleanTreeSha, withTempWorktree, ensureWorktree } from "@/lib/git";
import { commitFile, git, makeRepo, uid, writeFile } from "./helpers";

/** A branch off main carrying one commit that writes `content` to `file`. */
async function branchWith(repo: string, name: string, file: string, content: string) {
  await git(repo, "checkout", "-q", "main");
  await git(repo, "checkout", "-q", "-b", name);
  await commitFile(repo, file, content, `${name} edits ${file}`);
  await git(repo, "checkout", "-q", "main");
  return name;
}

describe("branchCollisions", () => {
  it("finds the pair that disagrees and leaves the rest alone", async () => {
    const repo = await makeRepo();
    // a and b both rewrite file.txt — irreconcilable with each other.
    await branchWith(repo, "a", "file.txt", "from a\n");
    await branchWith(repo, "b", "file.txt", "from b\n");
    // c touches something else entirely.
    await branchWith(repo, "c", "other.txt", "from c\n");

    const found = await branchCollisions(repo, ["a", "b", "c"]);

    expect(found).toHaveLength(1);
    expect(found[0].files).toEqual(["file.txt"]);
    expect([found[0].a, found[0].b].sort()).toEqual(["a", "b"]);
  });

  it("reports nothing when every branch touches a different file", async () => {
    const repo = await makeRepo();
    await branchWith(repo, "a", "a.txt", "a\n");
    await branchWith(repo, "b", "b.txt", "b\n");

    expect(await branchCollisions(repo, ["a", "b"])).toEqual([]);
  });

  // The regression that motivates this: two branches can each merge main
  // cleanly and still be irreconcilable with one another. Checking each against
  // the base — which is all the per-task sync banner ever did — says "fine".
  it("catches a pair that each merge the base cleanly", async () => {
    const repo = await makeRepo();
    await branchWith(repo, "a", "file.txt", "from a\n");
    await branchWith(repo, "b", "file.txt", "from b\n");

    // Each against main: clean, because main never moved.
    expect(await branchCollisions(repo, ["a", "main"])).toEqual([]);
    expect(await branchCollisions(repo, ["b", "main"])).toEqual([]);
    // Against each other: not clean.
    expect(await branchCollisions(repo, ["a", "b"])).toHaveLength(1);
  });

  it("ignores branches that do not exist rather than throwing", async () => {
    const repo = await makeRepo();
    await branchWith(repo, "a", "a.txt", "a\n");
    expect(await branchCollisions(repo, ["a", "ghost", ""])).toEqual([]);
  });
});

describe("cleanTreeSha", () => {
  it("is the HEAD sha for a clean tree", async () => {
    const repo = await makeRepo();
    expect(await cleanTreeSha(repo)).toBe(await git(repo, "rev-parse", "HEAD"));
  });

  // The cache key must never let a dirty tree share an entry with the commit it
  // sits on — uncommitted edits are exactly what a commit sha cannot see.
  it("is empty for a dirty tree, so nothing caches against it", async () => {
    const repo = await makeRepo();
    writeFile(repo, "scratch.txt", "uncommitted\n");
    expect(await cleanTreeSha(repo)).toBe("");
  });

  it("is empty for something that is not a repo", async () => {
    expect(await cleanTreeSha("/nonexistent-path-" + uid())).toBe("");
  });
});

describe("withTempWorktree", () => {
  it("checks the ref out, hands over the path, and removes it after", async () => {
    const repo = await makeRepo();
    await branchWith(repo, "feature", "only-on-feature.txt", "yes\n");

    let seen = "";
    const result = await withTempWorktree(repo, "feature", "t-" + uid(), async (dir) => {
      seen = dir;
      expect(await git(dir, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "feature"));
      return "returned";
    });

    expect(result).toBe("returned");
    const worktrees = await git(repo, "worktree", "list");
    expect(worktrees).not.toContain(seen);
  });

  it("removes the worktree even when the body throws", async () => {
    const repo = await makeRepo();
    let seen = "";
    await expect(
      withTempWorktree(repo, "main", "t-" + uid(), async (dir) => {
        seen = dir;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await git(repo, "worktree", "list")).not.toContain(seen);
  });

  it("does not disturb an existing task worktree", async () => {
    const repo = await makeRepo();
    const wt = await ensureWorktree(repo, uid());
    if (!wt) throw new Error("no worktree");
    await withTempWorktree(repo, "main", "t-" + uid(), async () => "ok");
    expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  });
});
