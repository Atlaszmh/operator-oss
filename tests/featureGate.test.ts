import { beforeEach, describe, expect, it } from "vitest";
import { runFeatureGate, runTestsIn, clearTestCache } from "@/lib/gates";
import { createFeatureBranch } from "@/lib/git";
import { createProject, createFeature, updateProject, updateFeature } from "@/lib/store";
import { commitFile, git, makeRepo, uid } from "./helpers";

// A project on a real repo, plus a feature on its own integration branch.
async function fixture(testCommand: string) {
  const repo = await makeRepo();
  const project = updateProject(createProject({ name: `FG-${uid()}` }).id, {
    repo_path: repo,
    branch: "main",
    test_command: testCommand,
  })!;
  const created = createFeature({ project_id: project.id, name: `Feat-${uid()}` });
  const branch = `feature/${created.id}`;
  await createFeatureBranch(repo, branch, "main");
  const feature = updateFeature(created.id, { branch })!;
  return { repo, project, feature, branch };
}

beforeEach(() => clearTestCache());

describe("runFeatureGate", () => {
  // The hole this closes: every member task is gated in its own worktree, so a
  // set of individually-green changes could assemble into a red branch and ship
  // with nothing having run the suite against the result.
  it("fails the feature when the assembled branch fails the project's tests", async () => {
    const { repo, project, feature, branch } = await fixture("sh ./check.sh");
    await git(repo, "checkout", "-q", branch);
    await commitFile(repo, "check.sh", "exit 1\n", "a check that fails");
    await git(repo, "checkout", "-q", "main");

    const gate = await runFeatureGate(project, feature);
    expect(gate.ran).toBe(true);
    expect(gate.ok).toBe(false);
    expect(gate.inconclusive).toBeFalsy();
  }, 30_000);

  it("passes when the assembled branch is green", async () => {
    const { repo, project, feature, branch } = await fixture("sh ./check.sh");
    await git(repo, "checkout", "-q", branch);
    await commitFile(repo, "check.sh", "exit 0\n", "a check that passes");
    await git(repo, "checkout", "-q", "main");

    const gate = await runFeatureGate(project, feature);
    expect(gate.ok).toBe(true);
    expect(gate.ran).toBe(true);
  }, 30_000);

  // It tests the FEATURE branch, not whatever the main tree happens to be on.
  it("reads the feature branch even when main has a passing check", async () => {
    const { repo, project, feature, branch } = await fixture("sh ./check.sh");
    await commitFile(repo, "check.sh", "exit 0\n", "main is green");
    await git(repo, "checkout", "-q", branch);
    await commitFile(repo, "check.sh", "exit 1\n", "the feature is not");
    await git(repo, "checkout", "-q", "main");

    expect((await runFeatureGate(project, feature)).ok).toBe(false);
  }, 30_000);

  it("is a no-op for a project with no test command", async () => {
    const { project, feature } = await fixture("");
    const gate = await runFeatureGate(project, feature);
    expect(gate).toMatchObject({ ok: true, ran: false });
  });

  it("reports inconclusive rather than failure when the branch cannot be checked out", async () => {
    const { project, feature } = await fixture("sh ./check.sh");
    const broken = updateFeature(feature.id, { branch: "no/such/branch" })!;
    const gate = await runFeatureGate(project, broken);
    expect(gate.ok).toBe(false);
    expect(gate.inconclusive).toBe(true);
  }, 30_000);

  it("leaves no worktree behind", async () => {
    const { repo, project, feature, branch } = await fixture("sh ./check.sh");
    await git(repo, "checkout", "-q", branch);
    await commitFile(repo, "check.sh", "exit 0\n", "green");
    await git(repo, "checkout", "-q", "main");

    await runFeatureGate(project, feature);
    const list = await git(repo, "worktree", "list");
    expect(list).not.toContain(".tmp-gate-");
  }, 30_000);
});

describe("test result cache", () => {
  it("reuses a result for an unchanged clean tree", async () => {
    const repo = await makeRepo();
    // Appends a line per run, so the output itself counts the invocations.
    const project = updateProject(createProject({ name: `Cache-${uid()}` }).id, {
      repo_path: repo,
      branch: "main",
      test_command: "echo ran >> /tmp/orch-cache-probe-" + uid() + "; echo done",
    })!;

    const first = await runTestsIn(project, repo);
    const second = await runTestsIn(project, repo);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first); // served from cache, byte for byte
  }, 30_000);

  it("does not reuse across a commit", async () => {
    const repo = await makeRepo();
    const project = updateProject(createProject({ name: `Cache-${uid()}` }).id, {
      repo_path: repo,
      branch: "main",
      test_command: "git rev-parse HEAD",
    })!;

    const before = await runTestsIn(project, repo);
    await commitFile(repo, "moved.txt", "x\n", "move the tree");
    const after = await runTestsIn(project, repo);

    expect(after.output.trim()).not.toBe(before.output.trim());
  }, 30_000);
});
