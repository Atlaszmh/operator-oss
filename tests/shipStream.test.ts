import { describe, expect, it } from "vitest";
import { POST as shipRoute } from "@/app/api/features/[id]/ship/route";
import { createFeatureBranch } from "@/lib/git";
import { createProject, createFeature, updateProject, updateFeature, getFeature } from "@/lib/store";
import { commitFile, git, makeRepo, ndjson, uid } from "./helpers";

// Shipping streams its progress instead of answering once at the end, because
// the feature gate alone runs the project's whole test command — minutes of
// nothing on screen but a disabled button. The contract that buys: newline-
// delimited JSON, a step pair per phase, and a final `result` line.
//
// The cost of streaming is that the HTTP status is committed before any work
// runs, so the failures that used to be a 409 are now fields of that last line.
// That reordering is the part most likely to be broken by a later edit — a
// caller that goes back to trusting the status code would report a red gate as
// a successful ship — so it's what these tests hold down.

async function fixture(testCommand: string) {
  const repo = await makeRepo();
  const project = updateProject(createProject({ name: `SH-${uid()}` }).id, {
    repo_path: repo,
    branch: "main",
    test_command: testCommand,
  })!;
  const created = createFeature({ project_id: project.id, name: `Feat-${uid()}` });
  const branch = `feature/${created.id}`;
  await createFeatureBranch(repo, branch, "main");
  const feature = updateFeature(created.id, { branch })!;
  // Something to actually merge — a ship with nothing ahead is a no-op.
  await git(repo, "checkout", "-q", branch);
  await commitFile(repo, `${uid()}.txt`, "work\n", "feature work");
  await git(repo, "checkout", "-q", "main");
  return { repo, project, feature, branch };
}

/** Drive the route and split its body into the lines it emitted. */
async function ship(featureId: string) {
  const res = await shipRoute(new Request(`http://localhost/api/features/${featureId}/ship`, { method: "POST" }), {
    params: Promise.resolve({ id: featureId }),
  });
  return ndjson(res);
}

describe("POST /api/features/:id/ship", () => {
  it("streams a step pair per phase and ends with the result", async () => {
    const { project, feature } = await fixture("true");
    const { status, lines } = await ship(feature.id);

    expect(status).toBe(200);
    const last = lines[lines.length - 1];
    expect(last.type).toBe("result");
    expect(last.ok).toBe(true);
    expect(String(last.text)).toContain(`merged ${feature.branch} into ${project.branch}`);

    // Every announced step is also reported done, in order, and the gate and the
    // merge are both among them.
    const started = lines.filter((l) => l.type === "step").map((l) => l.key);
    const finished = lines.filter((l) => l.type === "step_done").map((l) => l.key);
    expect(started).toEqual(finished);
    expect(started).toContain("gate");
    expect(started).toContain("merge");
    // A step's timing is what the UI renders next to the tick.
    for (const l of lines.filter((x) => x.type === "step_done")) expect(typeof l.ms).toBe("number");

    // The work really happened — this is a ship, not a progress animation.
    expect(getFeature(feature.id)!.merged_at).toBeGreaterThan(0);
    expect(getFeature(feature.id)!.archived).toBe(1);
  }, 30_000);

  it("reports a failed gate in the final line, not as a 409, and ships nothing", async () => {
    const { repo, feature, branch } = await fixture("sh ./check.sh");
    await git(repo, "checkout", "-q", branch);
    await commitFile(repo, "check.sh", "exit 1\n", "a check that fails");
    await git(repo, "checkout", "-q", "main");

    const { status, lines } = await ship(feature.id);

    // 200 — the status was committed before the gate ever ran. The failure is in
    // the body, which is exactly why the client must not read the status alone.
    expect(status).toBe(200);
    const last = lines[lines.length - 1];
    expect(last.type).toBe("result");
    expect(last.ok).toBeUndefined();
    expect(last.gateFailed).toBe(true);
    expect(String(last.error)).toContain(branch);

    // It stopped at the gate: no merge step was ever announced, and the feature
    // is untouched.
    expect(lines.filter((l) => l.type === "step").map((l) => l.key)).toEqual(["gate"]);
    expect(getFeature(feature.id)!.merged_at).toBe(0);
    expect(getFeature(feature.id)!.archived).toBe(0);
  }, 30_000);

  // The point of the whole change: the first step is READABLE while the ship is
  // still running. Asserted causally rather than on a stopwatch — at the moment
  // the first line arrives the merge has demonstrably not happened yet, which
  // anything that buffered the body to the end could not produce.
  it("emits the first step before the ship has finished", async () => {
    const { feature } = await fixture("sleep 2");
    const res = await shipRoute(new Request(`http://localhost/x`, { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    const reader = res.body!.getReader();

    const first = await reader.read();
    const line = JSON.parse(new TextDecoder().decode(first.value).split("\n")[0]);
    expect(line).toMatchObject({ type: "step", key: "gate" });
    // Still mid-flight: the gate is sleeping and nothing has landed on main.
    expect(getFeature(feature.id)!.merged_at).toBe(0);

    // Drain, so the route runs to completion and cleans its temp worktree up.
    for (;;) if ((await reader.read()).done) break;
    expect(getFeature(feature.id)!.merged_at).toBeGreaterThan(0);
  }, 30_000);

  it("still answers a pre-flight refusal as an ordinary non-2xx", async () => {
    // Nothing has been streamed yet at this point, so the status code is still
    // the right channel — and the client's error handling depends on it.
    const { status, lines } = await ship("no-such-feature");
    expect(status).toBe(404);
    expect(lines[0].error).toBe("not found");
  });
});
