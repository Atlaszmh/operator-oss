import { describe, it, expect } from "vitest";
import { createProject, createFeature, updateFeature, getFeature, listFeatures } from "@/lib/store";
import { createFeatureBranch, landBranch } from "@/lib/git";
import { syncFeaturesToBase, featuresToSync, summarizeSync } from "@/lib/featureSync";
import { POST as shipRoute } from "@/app/api/features/[id]/ship/route";
import { git, makeRepo, commitFile, ndjson } from "./helpers";

// A project whose repo is a real git fixture, plus a feature on its own
// integration branch forked from main.
async function projectWithFeature(name: string, branch: string) {
  const repo = await makeRepo();
  const project = createProject({ name, repo_path: repo, branch: "main" });
  const feature = createFeature({ project_id: project.id, name: `${name} feature` });
  const cut = await createFeatureBranch(repo, branch, "main");
  updateFeature(feature.id, { branch, base_sha: cut!.sha });
  return { repo, project, feature: getFeature(feature.id)! };
}

/** Commits a file straight onto the project branch, as a ship or a task merge would. */
async function landOnMain(repo: string, file: string, body: string) {
  await git(repo, "checkout", "main");
  await commitFile(repo, file, body, `land ${file}`);
}

describe("featuresToSync — which features a landing catches up", () => {
  it("skips the feature that just shipped, branchless, shipped and archived features", () => {
    const f = (over: Partial<Record<string, unknown>>) =>
      ({ id: "x", branch: "b", archived: 0, merged_at: 0, ...over }) as never;
    const rows = [
      f({ id: "live", branch: "feat/live" }),
      f({ id: "justShipped", branch: "feat/shipped-now" }),
      f({ id: "branchless", branch: "" }),
      f({ id: "alreadyShipped", branch: "feat/old", merged_at: 123 }),
      f({ id: "archived", branch: "feat/arch", archived: 1 }),
    ];
    expect(featuresToSync(rows, "justShipped").map((r) => r.id)).toEqual(["live"]);
  });
});

describe("syncFeaturesToBase", () => {
  it("merges the project branch into every live feature branch", async () => {
    const { repo, project, feature } = await projectWithFeature("Sync One", "feat/one");
    await landOnMain(repo, "landed.txt", "from another feature\n");

    // Before: the feature branch knows nothing about what landed.
    const behindBefore = (await git(repo, "rev-list", "--count", "feat/one..main")).trim();
    expect(behindBefore).toBe("1");

    const results = await syncFeaturesToBase(project);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].alreadyMerged).toBe(false);
    // After: caught up — this is the whole point, divergence never accumulates.
    expect((await git(repo, "rev-list", "--count", "feat/one..main")).trim()).toBe("0");
    expect(getFeature(feature.id)!.sync_conflict).toBe("");
  });

  it("leaves the shipping feature alone", async () => {
    const { repo, project, feature } = await projectWithFeature("Sync Except", "feat/except");
    await landOnMain(repo, "landed.txt", "x\n");
    const results = await syncFeaturesToBase(project, { except: feature.id });
    expect(results).toHaveLength(0);
  });

  it("reports already-up-to-date without touching the branch", async () => {
    const { project } = await projectWithFeature("Sync Noop", "feat/noop");
    const results = await syncFeaturesToBase(project);
    expect(results[0].ok).toBe(true);
    expect(results[0].alreadyMerged).toBe(true);
  });

  it("parks a conflict on the feature instead of throwing", async () => {
    // Both sides edit the same line of the same file — the real collision shape:
    // two features registering themselves in one shared call site.
    const { repo, project, feature } = await projectWithFeature("Sync Clash", "feat/clash");
    await git(repo, "checkout", "feat/clash");
    await commitFile(repo, "hub.txt", "layer: feature\n", "feature edits the hub");
    await landOnMain(repo, "hub.txt", "layer: other\n");

    const results = await syncFeaturesToBase(project);

    expect(results[0].ok).toBe(false);
    expect(results[0].conflicts).toContain("hub.txt");
    const parked = getFeature(feature.id)!.sync_conflict;
    expect(parked).toContain("hub.txt");
    expect(parked).toContain("feat/clash");
  });

  it("clears a parked conflict once a later sync succeeds", async () => {
    const { repo, project, feature } = await projectWithFeature("Sync Clear", "feat/clear");
    updateFeature(feature.id, { sync_conflict: "stale note from an earlier landing" });
    await landOnMain(repo, "fresh.txt", "no clash here\n");

    await syncFeaturesToBase(project);

    expect(getFeature(feature.id)!.sync_conflict).toBe("");
  });

  it("keeps going when one feature conflicts, and still catches the others up", async () => {
    // The guarantee that matters: one stuck branch must not strand the rest.
    const { repo, project, feature } = await projectWithFeature("Sync Many", "feat/bad");
    const good = createFeature({ project_id: project.id, name: "good one" });
    const cut = await createFeatureBranch(repo, "feat/good", "main");
    updateFeature(good.id, { branch: "feat/good", base_sha: cut!.sha });

    await git(repo, "checkout", "feat/bad");
    await commitFile(repo, "hub.txt", "mine\n", "bad branch edits the hub");
    await landOnMain(repo, "hub.txt", "theirs\n");

    const results = await syncFeaturesToBase(project);
    const byName = Object.fromEntries(results.map((r) => [r.branch, r]));

    expect(byName["feat/bad"].ok).toBe(false);
    expect(byName["feat/good"].ok).toBe(true);
    expect((await git(repo, "rev-list", "--count", "feat/good..main")).trim()).toBe("0");
    expect(getFeature(feature.id)!.sync_conflict).not.toBe("");
    expect(getFeature(good.id)!.sync_conflict).toBe("");
  });

  it("does nothing for a project with no working directory", async () => {
    const project = createProject({ name: "No Repo" });
    expect(await syncFeaturesToBase(project)).toEqual([]);
  });

  it("survives a feature whose branch was deleted from the repo", async () => {
    // The branch is gone but the row still names it; the sweep must report it
    // and move on, never throw into the merge that already succeeded.
    const { repo, project, feature } = await projectWithFeature("Sync Gone", "feat/gone");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "feat/gone");
    await landOnMain(repo, "landed.txt", "x\n");

    const results = await syncFeaturesToBase(project);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(getFeature(feature.id)!.sync_conflict).not.toBe("");
  });
});

describe("summarizeSync", () => {
  const r = (over: Partial<Record<string, unknown>>) =>
    ({ featureId: "f", name: "F", branch: "b", ok: true, alreadyMerged: false, conflicts: [], ...over }) as never;

  it("says nothing when every branch was already current", () => {
    expect(summarizeSync([r({ alreadyMerged: true })])).toBe("");
  });

  it("names what moved and what is stuck", () => {
    const text = summarizeSync([
      r({ name: "Moved" }),
      r({ name: "Stuck", ok: false, conflicts: ["hub.ts"] }),
      r({ name: "Quiet", alreadyMerged: true }),
    ]);
    expect(text).toContain("Moved");
    expect(text).toContain("Stuck");
    expect(text).not.toContain("Quiet");
  });
});

describe("landBranch is the shared primitive", () => {
  it("syncing is the same merge as shipping with the arguments swapped", async () => {
    // Pinned because it is the reason a sync needs no worktree and no new git
    // path: the feature branch is just the target instead of the source.
    const { repo, project } = await projectWithFeature("Swap", "feat/swap");
    await landOnMain(repo, "a.txt", "a\n");
    const res = await landBranch({
      repoPath: repo,
      workBranch: project.branch,
      baseBranch: "feat/swap",
      message: "Merge main into feat/swap",
    });
    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("feat/swap");
  });
});

// ---------------------------------------------------------------- wiring
//
// syncFeaturesToBase is well covered above; what these pin is that the LANDING
// PATHS actually call it. That wiring is the part a refactor silently drops —
// the sweep would keep passing its own tests while nothing ever invoked it.

describe("the ship route catches sibling features up", () => {
  it("a shipped feature drags every other live branch forward", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Ship Wiring", repo_path: repo, branch: "main" });

    // Two features, each on its own integration branch off main.
    const shipping = createFeature({ project_id: project.id, name: "Ships now" });
    const sibling = createFeature({ project_id: project.id, name: "Still building" });
    const a = await createFeatureBranch(repo, "feat/ships", "main");
    const b = await createFeatureBranch(repo, "feat/sibling", "main");
    updateFeature(shipping.id, { branch: "feat/ships", base_sha: a!.sha });
    updateFeature(sibling.id, { branch: "feat/sibling", base_sha: b!.sha });

    // Real work on the shipping branch.
    await git(repo, "checkout", "feat/ships");
    await commitFile(repo, "shipped.txt", "the feature\n", "work on the shipping feature");
    await git(repo, "checkout", "main");

    // Before: the sibling has no idea this exists.
    expect((await git(repo, "rev-list", "--count", "feat/sibling..feat/ships")).trim()).toBe("1");

    const res = await shipRoute(new Request("http://x/api/features/x/ship?force=1", { method: "POST" }), {
      params: Promise.resolve({ id: shipping.id }),
    });
    expect(res.status).toBe(200);

    // After: the sibling carries what shipped, WITHOUT anyone opening it. This
    // is the whole feature — divergence is reconciled at the landing, not at
    // the sibling's own ship weeks later.
    expect((await git(repo, "rev-list", "--count", "feat/sibling..main")).trim()).toBe("0");
    expect(getFeature(sibling.id)!.sync_conflict).toBe("");
  });

  it("reports a sibling that could not follow, without failing the ship", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Ship Clash", repo_path: repo, branch: "main" });
    const shipping = createFeature({ project_id: project.id, name: "Ships anyway" });
    const sibling = createFeature({ project_id: project.id, name: "Will clash" });
    const a = await createFeatureBranch(repo, "feat/ships2", "main");
    const b = await createFeatureBranch(repo, "feat/clash2", "main");
    updateFeature(shipping.id, { branch: "feat/ships2", base_sha: a!.sha });
    updateFeature(sibling.id, { branch: "feat/clash2", base_sha: b!.sha });

    // Both edit the same line of the same hub file.
    await git(repo, "checkout", "feat/ships2");
    await commitFile(repo, "hub.txt", "theirs\n", "shipping feature edits the hub");
    await git(repo, "checkout", "feat/clash2");
    await commitFile(repo, "hub.txt", "mine\n", "sibling edits the hub");
    await git(repo, "checkout", "main");

    const res = await shipRoute(new Request("http://x/api/features/x/ship?force=1", { method: "POST" }), {
      params: Promise.resolve({ id: shipping.id }),
    });
    // The ship route streams its progress; its answer is the final line.
    const { result: body } = await ndjson<{ ok: boolean; text: string }>(res);

    // The ship SUCCEEDED — another feature's branch is not this one's failure.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // ...but it says so, and the sibling carries the reason for its own tile.
    expect(body.text).toContain("Will clash");
    expect(getFeature(sibling.id)!.sync_conflict).toContain("hub.txt");
  });
});
