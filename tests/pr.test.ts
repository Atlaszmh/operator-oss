import { describe, expect, it } from "vitest";
import { buildPrBody, createBranchPr } from "../lib/github";
import { createFeatureBranch } from "../lib/git";
import { commitFile, git, makeRepo } from "./helpers";

describe("buildPrBody", () => {
  it("stacks description, latest summary, and the attribution footer", () => {
    const body = buildPrBody({ description: "Add sparklines.", summary: "Built the chart component.", taskId: "t1" });
    expect(body).toBe(
      "Add sparklines.\n\n## Session summary\n\nBuilt the chart component.\n\n---\n_Opened by Agent Orchestrator (task t1)._"
    );
  });

  it("omits empty or whitespace-only sections", () => {
    const body = buildPrBody({ description: "  ", summary: undefined, taskId: "t2" });
    expect(body).toBe("---\n_Opened by Agent Orchestrator (task t2)._");
    expect(body).not.toContain("## Session summary");
  });

  it("keeps the summary section when only the description is missing", () => {
    const body = buildPrBody({ summary: "Refactored auth.", taskId: "t3" });
    expect(body.startsWith("## Session summary\n\nRefactored auth.")).toBe(true);
  });
});

// The nine-features bug. A feature shipped by hand while its last member was
// still gating leaves the branch fully contained in the project branch, so
// `gh pr create` came back with "GraphQL: No commits between main and
// feature/x" — which autopilot then escalated as if the WORK had failed.
// Answered here, at the one function all three PR callers route through
// (autopilot, POST /features/:id/pr, createTaskPr), and answered locally: it
// must never reach the network to learn there was nothing to send.
describe("createBranchPr: nothing to open", () => {
  it("refuses a branch the base already contains, before gh or any push", async () => {
    const repo = await makeRepo();
    await createFeatureBranch(repo, "feature/landed", "main");

    const res = await createBranchPr({ cwd: repo, branch: "feature/landed", baseBranch: "main", title: "t", body: "b" });

    expect(res.ok).toBe(false);
    expect(res.nothingToOpen).toBe(true);
    expect(res.error).toContain("already merged into main");
  });

  it("does not stand in the way of a branch that has commits of its own", async () => {
    const repo = await makeRepo();
    await createFeatureBranch(repo, "feature/live", "main");
    await git(repo, "checkout", "feature/live");
    await commitFile(repo, "new.txt", "work\n", "real work");
    await git(repo, "checkout", "main");

    const res = await createBranchPr({ cwd: repo, branch: "feature/live", baseBranch: "main", title: "t", body: "b" });

    // It gets past the guard and fails on the environment instead (no gh, or no
    // origin remote on this fixture) — never on "nothing to open", and never by
    // pushing: makeRepo has no remote to push to.
    expect(res.nothingToOpen).toBeFalsy();
    expect(res.error).not.toContain("already merged");
  });
});
