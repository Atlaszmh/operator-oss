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
