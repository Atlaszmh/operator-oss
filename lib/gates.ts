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
import { taskDiff } from "./git";
import { reviewTask } from "./agents/oneshots";
import { buildReviewPrompt, parseVerdict, clip } from "./agents/shared";
import { resolveFeatures } from "./features";
import { GATE_TEST_TIMEOUT_MS } from "./config";
import type { Feature, GateVerdict, Project, Task } from "./types";

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
  const cmd = project.test_command?.trim();
  if (!cmd || !task.worktree_path) return { ran: false, ok: true, output: "" };

  return new Promise<TestRun>((resolveRun) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        cwd: task.worktree_path,
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
    return {
      ok: false,
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

/**
 * Shadow mode: run the whole gate and record the verdict, but never merge on it.
 * The point is to calibrate the reviewer against real work before trusting it to
 * land code unattended — a reviewer that rubber-stamps has automated a rubber
 * stamp, and you only find that out by watching it judge things you also judged.
 */
export const gateIsAdvisory = (): boolean => resolveFeatures().autopilotShadow;
