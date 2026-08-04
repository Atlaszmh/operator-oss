import path from "node:path";
import os from "node:os";

/**
 * Per-instance configuration, driven entirely by environment variables so an
 * instance can be relocated (fresh container, different user, different ports)
 * with zero code edits. Every value has a documented default — see README
 * "Configuration" and .env.example.
 *
 * Server-side only. The two plain-Node entrypoints (server.js, pty-server.js)
 * can't import TS, so they read the same env vars directly — keep names in sync.
 */

/** App-data dir for the SQLite database. */
export const DB_DIR = process.env.ORCH_DB_DIR || path.join(os.homedir(), ".zen-orchestrator");

/** Where per-task git worktrees are created (must be outside any project repo). */
export const WORKTREES_DIR =
  process.env.ORCH_WORKTREES_DIR || path.join(os.homedir(), ".agent-orchestrator", "worktrees");

/** Where "Clone a repository" puts cloned repos (the container home's projects/). */
export const PROJECTS_DIR = process.env.ORCH_PROJECTS_DIR || path.join(os.homedir(), "projects");

/**
 * Path to the user's logged-in `claude` binary (Max subscription). The SDK
 * auto-detects it on PATH, but Next's server may run with a trimmed PATH, so
 * we pin it.
 */
export const CLAUDE_CLI_PATH =
  process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), ".local", "bin", "claude");

/**
 * Path to the `codex` binary the Codex driver drives (via @openai/codex-sdk).
 * Empty = let the SDK auto-resolve the binary bundled with its @openai/codex
 * dependency, and let the auth helpers fall back to `codex` on PATH (the Docker
 * image installs it globally next to `claude`). Set this to pin a specific
 * binary when PATH is trimmed or a different install should be used.
 */
export const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || "";

/**
 * Opt-in to billing an environment-provided agent API key (ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY). Off by default: both entrypoints
 * strip those vars at boot (lib/env-keys.mjs — server.js and pty-server.js read
 * the env name directly, as does docker/entrypoint.sh) so a key leaked in from
 * a shell profile or unit file can't silently switch turns from the connected
 * subscription login to per-token billing (issue #4). Keys saved through the
 * app's own "I have an API key" path are unaffected — they're re-applied from
 * their 0600 files at db init, after the strip.
 */
export const ALLOW_API_KEY_ENV = ["1", "true", "on"].includes(
  String(process.env.ORCH_ALLOW_API_KEY_ENV || "").toLowerCase(),
);

/**
 * Base TCP port for per-project managed services. Each project is assigned a
 * stable port (base + slot) at creation, stored on its row, injected as PORT
 * into the dev/setup/test service env and the project's PTY shell. Override to
 * relocate the block (e.g. avoid a clash with the app/pty ports). See lib/services.ts.
 */
export const SERVICE_PORT_BASE = process.env.ORCH_SERVICE_PORT_BASE
  ? Number(process.env.ORCH_SERVICE_PORT_BASE)
  : 4300;

/**
 * Per-service log ring-buffer cap (lines). Each managed service keeps at most
 * this many captured stdout/stderr lines in memory — enough to scroll back
 * through startup + recent output without growing unbounded for a dev server
 * that's been up for days.
 */
export const SERVICE_LOG_LINES = process.env.ORCH_SERVICE_LOG_LINES
  ? Number(process.env.ORCH_SERVICE_LOG_LINES)
  : 1500;

/**
 * The origin the app answers on over loopback, for in-container server-to-server
 * calls. The stdio MCP bridge (scripts/orch-mcp.mjs, spawned by the Codex CLI)
 * POSTs the suggest_task / expose_service tool calls back to the app's internal
 * endpoints at this base. Defaults to 127.0.0.1 on the app's own PORT (server.js
 * reads the same PORT). Override only if the app is reached differently from
 * inside the box.
 */
export const INTERNAL_BASE_URL =
  process.env.ORCH_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

/** Absolute path to the stdio MCP bridge the non-Claude drivers register per turn. */
export const ORCH_MCP_SCRIPT = path.join(process.cwd(), "scripts", "orch-mcp.mjs");

/**
 * How many of one feature's tasks autopilot runs at once (lib/autopilot.ts).
 * Parallel wherever the dependency graph allows it; this cap is what stops a
 * twenty-task plan from opening twenty sessions against one login. Per-feature
 * overrides are deliberately not a thing — raise this if 2 is too slow.
 */
export const AUTOPILOT_CONCURRENCY = process.env.ORCH_AUTOPILOT_CONCURRENCY
  ? Number(process.env.ORCH_AUTOPILOT_CONCURRENCY)
  : 2;

/**
 * How many times a task may fail its gate (or fail to resolve a merge conflict)
 * before autopilot stops and escalates it to the user. Low on purpose: an agent
 * that hasn't fixed it in two rounds is usually missing context only the user
 * has, and further rounds just spend quota. Expect to tune this — the right
 * number is empirical, which is exactly why it's an env var.
 *
 * Raised from 2 to 3 on evidence: a full round is review → fix → re-review, and
 * at 2 a task that took one round to understand the feedback had no round left
 * to act on it. Three is still bounded and still cheap next to a human picking
 * the work back up cold.
 */
export const AUTOPILOT_ATTEMPTS = process.env.ORCH_AUTOPILOT_ATTEMPTS
  ? Number(process.env.ORCH_AUTOPILOT_ATTEMPTS)
  : 3;

/**
 * Age at which a MERGED task's worktree is pruned automatically, in ms.
 *
 * Worktrees are only ever removed when someone opens the maintenance panel and
 * picks them, so they accumulate silently — one instance had 60 stranded
 * checkouts for 76 tasks, every one of them merged. Disk is the small cost; the
 * real one is that `git branch` and `git worktree list` stop being readable, and
 * a human debugging a merge has to scroll past sixty dead entries to find the
 * two that matter.
 *
 * Only touches worktrees the maintenance route already considers safe (merged,
 * clean, nothing unmerged — see worktreePruneSafety), and keeps the branch, so
 * the task stays reopenable and its diff base survives. 0 disables.
 */
export const WORKTREE_PRUNE_AFTER_MS = process.env.ORCH_WORKTREE_PRUNE_AFTER_MS
  ? Number(process.env.ORCH_WORKTREE_PRUNE_AFTER_MS)
  : 7 * 24 * 60 * 60 * 1000;

/**
 * Hard timeout for an autopilot gate's test run, in ms. A hung suite must not
 * pin a queue slot forever — the run is killed and the task escalates, which is
 * information, where waiting is not. (10 minutes.)
 */
export const GATE_TEST_TIMEOUT_MS = process.env.ORCH_GATE_TEST_TIMEOUT_MS
  ? Number(process.env.ORCH_GATE_TEST_TIMEOUT_MS)
  : 10 * 60 * 1000;

/**
 * The public origin the app is served from (e.g. https://orch.example.com when
 * behind a tunnel/reverse proxy). Used by the client to build absolute
 * ws(s):// URLs. Empty = same-origin via window.location, which is correct for
 * any single-hostname deployment.
 */
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
