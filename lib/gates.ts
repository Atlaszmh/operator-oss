// Autopilot's done gate: what must be true for a task to merge without anyone
// reading its transcript.
//
// Two halves, both required. The tests prove the change RUNS; the reviewer
// proves it's the RIGHT THING. Neither alone is enough to merge on — a green
// suite says nothing about whether the task was understood, and a reviewer
// reading a diff can happily approve code that doesn't execute. This is the
// judgement being automated, so it is the piece most worth being strict about.
//
// A failure here is never fatal: it comes back as `feedback` phrased as
// instructions, which lib/autopilot.ts sends into the task as an ordinary turn.

import { spawn } from "node:child_process";
import { taskDiff, cleanTreeSha, withTempWorktree } from "./git";
import { reviewTask } from "./agents/oneshots";
import { buildReviewPrompt, parseVerdict, clip } from "./agents/shared";
import { resolveFeatures } from "./features";
import { GATE_TEST_TIMEOUT_MS } from "./config";
import type { Feature, GateVerdict, Project, Task } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __orchTestCache: Map<string, { ok: boolean; output: string }> | undefined;
}

/**
 * Results of the project's test command, keyed by the exact tree it ran against.
 *
 * The same suite is now asked for several times per task — the done gate, each
 * retry, the pre-merge re-check when the base moves, and the feature gate — and
 * on a real project it is the expensive half by a wide margin (a Rust + wasm
 * gate is minutes). Re-running it against a tree that has not moved one byte
 * buys nothing.
 *
 * Keyed on a CLEAN tree's HEAD sha (see cleanTreeSha): a dirty worktree gets no
 * key and is always re-run, because a commit sha says nothing about uncommitted
 * edits. Kept on globalThis so it survives dev HMR, same as lib/events.ts.
 *
 * ponytail: in-memory and per-process, so a restart re-runs everything once.
 * Persist to the DB if cold-start cost ever shows up.
 */
const TEST_CACHE_MAX = 64;

function testCache(): Map<string, { ok: boolean; output: string }> {
  if (!global.__orchTestCache) global.__orchTestCache = new Map();
  return global.__orchTestCache;
}

function rememberTestRun(key: string, value: { ok: boolean; output: string }): void {
  const cache = testCache();
  cache.delete(key);
  cache.set(key, value);
  // Insertion-ordered Map — the first key is the least recently written.
  while (cache.size > TEST_CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Drop every cached run for a project whose test command changed under us. */
export function clearTestCache(): void {
  testCache().clear();
}

// Cap on captured test output. The reviewer reads this, and a 200k-line suite
// log would crowd the diff out of its context window. Kept as a TAIL, not a
// head: every runner puts its failure summary at the bottom.
const TEST_OUTPUT_CHARS = 6000;

// Cap on the diff handed to the reviewer. Past this the reviewer's own Read/Grep
// tools are the better instrument anyway — it's running in the worktree.
const DIFF_CHARS = 60_000;

interface TestRun {
  ran: boolean;
  ok: boolean;
  output: string;
}

/**
 * Run the project's test command in the TASK'S WORKTREE.
 *
 * Deliberately not lib/services.ts, which spawns with `cwd: project.repo_path`
 * (services.ts) — gating the shared tree would prove nothing whatsoever about
 * the isolated branch we're about to merge. This is a one-shot child with a hard
 * timeout, not a supervised service, so there's nothing for the supervisor to own.
 */
async function runTests(project: Project, task: Task): Promise<TestRun> {
  return runTestsIn(project, task.worktree_path);
}

/**
 * The project's test command against an arbitrary checkout, memoised on the
 * tree it ran against. Shared by the per-task done gate, the pre-merge re-check
 * and the feature gate, so all three agree on what "the tests pass" means and
 * none of them pays for a run another already did.
 */
export async function runTestsIn(project: Project, dir: string): Promise<TestRun> {
  const cmd = project.test_command?.trim();
  if (!cmd || !dir) return { ran: false, ok: true, output: "" };

  const key = await cleanTreeSha(dir).then((sha) => (sha ? `${sha} ${cmd}` : ""));
  if (key) {
    const hit = testCache().get(key);
    if (hit) return { ran: true, ok: hit.ok, output: hit.output };
  }

  const result = await spawnTests(cmd, dir, project);
  // Only a run that actually completed is worth remembering — a suite killed by
  // the timeout says nothing repeatable about the tree.
  if (key && !/exceeded .* and was killed/.test(result.output)) {
    rememberTestRun(key, { ok: result.ok, output: result.output });
  }
  return result;
}

function spawnTests(cmd: string, dir: string, project: Project): Promise<TestRun> {
  return new Promise<TestRun>((resolveRun) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        cwd: dir,
        shell: true,
        detached: true, // own process group, so the timeout can kill the whole tree
        env: { ...process.env, CI: "1", ...(project.port ? { PORT: String(project.port) } : {}) },
      });
    } catch (e) {
      resolveRun({ ran: true, ok: false, output: `[gate] could not start the test command: ${(e as Error).message}` });
      return;
    }

    let out = "";
    const take = (b: Buffer) => {
      out += b.toString();
      // Keep memory bounded on a chatty suite; we only ever report the tail.
      if (out.length > TEST_OUTPUT_CHARS * 4) out = out.slice(-TEST_OUTPUT_CHARS * 2);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);

    let done = false;
    const settle = (ok: boolean, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ ran: true, ok, output: text.slice(-TEST_OUTPUT_CHARS) });
    };

    const timer = setTimeout(() => {
      // Negative pid kills the whole process group — a test command is usually a
      // shell wrapping a runner wrapping workers, and killing only the shell
      // leaves the workers holding the port.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      settle(false, `${out}\n[gate] the test command exceeded ${Math.round(GATE_TEST_TIMEOUT_MS / 1000)}s and was killed`);
    }, GATE_TEST_TIMEOUT_MS);

    child.on("error", (e) => settle(false, `${out}\n[gate] could not run the test command: ${e.message}`));
    child.on("close", (code) => settle(code === 0, out));
  });
}

/** The task's changes as one patch, for the reviewer. Best-effort: a diff we
 *  can't produce becomes an empty diff, which the prompt treats as a FAIL. */
async function diffText(project: Project, task: Task, baseBranch: string): Promise<string> {
  try {
    const d = await taskDiff(project.repo_path, task.worktree_path, task.base_sha, baseBranch);
    return d.files
      .map((f) => `--- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n${f.binary ? "(binary)" : f.patch}`)
      .join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The full gate for one finished task.
 *
 * Short-circuits on a red suite: there is nothing useful a reviewer can say
 * about code that doesn't pass its own tests, and the review is the expensive
 * half. A project with no test command doesn't fail the gate — it just doesn't
 * get that half, and the reviewer is told so explicitly rather than being left
 * to assume the change was proven to run.
 */
export async function runGate(task: Task, project: Project, feature: Feature | undefined): Promise<GateVerdict> {
  const tests = await runTests(project, task);
  if (tests.ran && !tests.ok) {
    return {
      ok: false,
      testsRan: true,
      reviewRan: false,
      feedback:
        `The test command \`${project.test_command}\` failed in your worktree, so this task was not merged. ` +
        `Fix it — that means making the code correct, not deleting, skipping, or weakening the failing test.\n\n` +
        `\`\`\`\n${tests.output}\n\`\`\``,
    };
  }

  const baseBranch = feature?.branch || project.branch;
  const prompt = buildReviewPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    featureContext: feature?.context ?? "",
    projectContext: project.context,
    diff: clip(await diffText(project, task, baseBranch), DIFF_CHARS),
    testOutput: tests.ran
      ? `The project's test command passed.\n${tests.output}`
      : "(this project has no test command, so nothing proved the change runs)",
  });

  let raw: string;
  try {
    raw = await reviewTask(prompt, task.worktree_path || project.repo_path);
  } catch (e) {
    // No connected utility agent, or the review turn died. Fail closed and say
    // why: an unrunnable reviewer must not become an automatic merge.
    //
    // But fail closed INCONCLUSIVE, not FAIL. This is a statement about the
    // reviewer, not about the diff — usually a usage limit or a dropped turn,
    // both of which pass on their own. Charging it to the task burned its
    // retries and blocked finished work behind an outage.
    return {
      ok: false,
      inconclusive: true,
      testsRan: tests.ran,
      reviewRan: false,
      feedback: `The review could not run: ${(e as Error).message}`,
    };
  }

  const verdict = parseVerdict(raw);
  const noTests = tests.ran
    ? ""
    : "\n\n(Note: this project has no test command configured, so nothing proved the change actually runs.)";

  return {
    ok: verdict.ok,
    testsRan: tests.ran,
    reviewRan: true,
    feedback: verdict.ok
      ? verdict.notes
      : `The review did not pass, so this task was not merged. Address the following, then finish the work:\n\n${verdict.notes}${noTests}`,
  };
}

export interface FeatureGateResult {
  ok: boolean;
  ran: boolean; // false = nothing to prove with (no test command, or no branch)
  output: string;
  inconclusive?: boolean; // the gate could not run — a git failure, not a red suite
}

/**
 * The done gate for an assembled FEATURE branch.
 *
 * Every member is gated in its own worktree against its own base, which proves
 * each change works in isolation and nothing whatsoever about the members
 * together. That gap is not theoretical: a feature whose members were each green
 * merged into the project branch with zero git conflicts and broke the project's
 * cross-platform determinism check — git had no reason to report anything, and
 * nothing ran the suite against the assembled result.
 *
 * So: run the project's test command against a throwaway checkout of the
 * integration branch, before the feature ships or opens a PR. Read-only with
 * respect to every branch involved — the checkout is detached and removed after.
 *
 * A git failure comes back `inconclusive` rather than as a red suite: "I could
 * not check" and "this is broken" are different claims, and only the second one
 * should read as the feature being at fault.
 */
export async function runFeatureGate(project: Project, feature: Feature): Promise<FeatureGateResult> {
  const cmd = project.test_command?.trim();
  if (!cmd) return { ok: true, ran: false, output: "" };
  if (!feature.branch || !project.repo_path) return { ok: true, ran: false, output: "" };

  try {
    return await withTempWorktree(project.repo_path, feature.branch, `gate-${feature.id}`, async (dir) => {
      const run = await runTestsIn(project, dir);
      return { ok: run.ok, ran: run.ran, output: run.output };
    });
  } catch (e) {
    return {
      ok: false,
      ran: false,
      inconclusive: true,
      output: `could not check out ${feature.branch} to test it: ${(e as Error).message}`,
    };
  }
}

/** The message a failed feature gate should put in front of the user. */
export function featureGateFailure(feature: Feature, project: Project, result: FeatureGateResult): string {
  if (result.inconclusive) return `The feature gate could not run: ${result.output}`;
  return (
    `\`${project.test_command}\` fails on ${feature.branch}, so this feature was not shipped.\n\n` +
    `Every task passed in its own worktree — this is the assembled branch failing, which is exactly ` +
    `what a per-task gate cannot see.\n\n\`\`\`\n${result.output}\n\`\`\``
  );
}

/**
 * Shadow mode: run the whole gate and record the verdict, but never merge on it.
 * The point is to calibrate the reviewer against real work before trusting it to
 * land code unattended — a reviewer that rubber-stamps has automated a rubber
 * stamp, and you only find that out by watching it judge things you also judged.
 */
export const gateIsAdvisory = (): boolean => resolveFeatures().autopilotShadow;
