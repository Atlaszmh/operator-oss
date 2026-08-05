import { describe, it, expect } from "vitest";
import {
  createProject,
  createFeature,
  createTask,
  getFeature,
  getTask,
  updateFeature,
  updateTask,
  listTasks,
  listFeatures,
  updateProject,
} from "@/lib/store";
import { createFeatureBranch, landBranch, worktreeSyncStatus } from "@/lib/git";
import {
  reconcileFeatureBranch,
  sweepFeatureHealth,
  fileConflictResolutionTask,
  resolutionTaskTitle,
  syncFeaturesToBase,
} from "@/lib/featureSync";
import { PATCH as patchFeature } from "@/app/api/features/[id]/route";
import { POST as resolveRoute } from "@/app/api/features/[id]/resolve/route";
import { git, makeRepo, commitFile } from "./helpers";

// One project + one feature on its own integration branch, with the fork point
// recorded the way the branch route records it.
async function fixture(name: string, branch: string) {
  const repo = await makeRepo();
  const project = createProject({ name, repo_path: repo, branch: "main" });
  const feature = createFeature({ project_id: project.id, name: `${name} feature` });
  const cut = await createFeatureBranch(repo, branch, "main");
  updateFeature(feature.id, { branch, base_sha: cut!.sha });
  return { repo, project, feature: getFeature(feature.id)! };
}

/** The rollup-carrying row reconcile takes (it reads `done`). */
const counted = (projectId: string, id: string) => listFeatures(projectId).find((f) => f.id === id)!;

const patchReq = (body: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- archive guard

describe("archiving a feature with unmerged commits", () => {
  it("refuses without force, names the count, and archives with force", async () => {
    const { repo, project, feature } = await fixture("Strand Guard", "feat/strand");
    await git(repo, "checkout", "feat/strand");
    await commitFile(repo, "work.txt", "unlanded\n", "work that never merged");
    await git(repo, "checkout", "main");

    const refused = await patchFeature(patchReq({ archived: 1 }), { params: Promise.resolve({ id: feature.id }) });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; unmerged: number };
    expect(body.unmerged).toBe(1);
    expect(body.error).toContain("feat/strand");
    expect(getFeature(feature.id)!.archived).toBe(0);

    const forced = await patchFeature(patchReq({ archived: 1, force: true }), { params: Promise.resolve({ id: feature.id }) });
    expect(forced.status).toBe(200);
    expect(getFeature(feature.id)!.archived).toBe(1);
  });

  it("archives freely when the branch has fully landed", async () => {
    const { repo, project, feature } = await fixture("Clean Archive", "feat/cleanarch");
    await git(repo, "checkout", "feat/cleanarch");
    await commitFile(repo, "work.txt", "landed\n", "the work");
    await git(repo, "checkout", "main");
    await landBranch({ repoPath: repo, workBranch: "feat/cleanarch", baseBranch: "main", message: "ship" });

    const res = await patchFeature(patchReq({ archived: 1 }), { params: Promise.resolve({ id: feature.id }) });
    expect(res.status).toBe(200);
    expect(getFeature(feature.id)!.archived).toBe(1);
  });

  it("does not guard branchless features or restores", async () => {
    const project = createProject({ name: "No Branch Archive" });
    const feature = createFeature({ project_id: project.id, name: "plain" });
    const res = await patchFeature(patchReq({ archived: 1 }), { params: Promise.resolve({ id: feature.id }) });
    expect(res.status).toBe(200);

    // Restoring is never guarded — it brings work BACK into view.
    const restore = await patchFeature(patchReq({ archived: 0 }), { params: Promise.resolve({ id: feature.id }) });
    expect(restore.status).toBe(200);
  });
});

// ---------------------------------------------------------------- reconcile

describe("reconcileFeatureBranch", () => {
  it("heals a lost ship stamp when the branch has fully landed", async () => {
    // The CH-31/CH-41 drift: merge commit on main, merged_at still 0.
    const { repo, project, feature } = await fixture("Heal", "feat/heal");
    createTask({ project_id: project.id, title: "member", feature_id: feature.id });
    updateTask(listTasks(project.id)[0].id, { status: "done" });
    await git(repo, "checkout", "feat/heal");
    await commitFile(repo, "work.txt", "x\n", "the work");
    await git(repo, "checkout", "main");
    await landBranch({ repoPath: repo, workBranch: "feat/heal", baseBranch: "main", message: "landed outside the route" });
    expect(getFeature(feature.id)!.merged_at).toBe(0);

    await reconcileFeatureBranch(project, counted(project.id, feature.id));

    expect(getFeature(feature.id)!.merged_at).toBeGreaterThan(0);
  });

  it("never stamps a fresh branch that has done no work", async () => {
    const { project, feature } = await fixture("Fresh", "feat/fresh");
    createTask({ project_id: project.id, title: "member", feature_id: feature.id });
    updateTask(listTasks(project.id)[0].id, { status: "done" });

    // tip == base_sha: ahead is 0 but nothing ever happened. Not shipped.
    await reconcileFeatureBranch(project, counted(project.id, feature.id));

    expect(getFeature(feature.id)!.merged_at).toBe(0);
  });

  it("never stamps a feature with no done members", async () => {
    // Guards the empty-feature-fast-forwarded case: reachable-from-main alone
    // must not read as "shipped" when no member ever finished.
    const { repo, project, feature } = await fixture("No Members", "feat/nomembers");
    await git(repo, "checkout", "feat/nomembers");
    await commitFile(repo, "stray.txt", "x\n", "stray commit");
    await git(repo, "checkout", "main");
    await landBranch({ repoPath: repo, workBranch: "feat/nomembers", baseBranch: "main", message: "landed" });

    await reconcileFeatureBranch(project, counted(project.id, feature.id));

    expect(getFeature(feature.id)!.merged_at).toBe(0);
  });

  it("parks and clears the post-ship-commits note", async () => {
    // The CH-30 strand: a member merges into the branch AFTER the feature
    // shipped and archived, and nobody ever looks at that branch again.
    const { repo, project, feature } = await fixture("Post Ship", "feat/postship");
    updateFeature(feature.id, { merged_at: Date.now(), archived: 1 });
    await git(repo, "checkout", "feat/postship");
    await commitFile(repo, "late.txt", "x\n", "work landed after shipping");
    await git(repo, "checkout", "main");

    await reconcileFeatureBranch(project, counted(project.id, feature.id));
    const noted = getFeature(feature.id)!;
    expect(noted.sync_conflict).toContain("after it shipped");
    expect(noted.sync_conflict).toContain("1 commit");

    // The late work lands → the note clears on the next reconcile.
    await landBranch({ repoPath: repo, workBranch: "feat/postship", baseBranch: "main", message: "land the late work" });
    await reconcileFeatureBranch(project, counted(project.id, feature.id));
    expect(getFeature(feature.id)!.sync_conflict).toBe("");
  });

  it("sweeps archived features too — that is where strands hide", async () => {
    const { repo, project, feature } = await fixture("Sweep Archived", "feat/sweeparch");
    updateFeature(feature.id, { merged_at: Date.now(), archived: 1 });
    await git(repo, "checkout", "feat/sweeparch");
    await commitFile(repo, "late.txt", "x\n", "stranded");
    await git(repo, "checkout", "main");

    await sweepFeatureHealth();

    expect(getFeature(feature.id)!.sync_conflict).toContain("after it shipped");
  });
});

// ---------------------------------------------------------------- resolution task

describe("the conflict resolution task", () => {
  it("is auto-filed by a conflicted sync, once, as a suggestion", async () => {
    const { repo, project, feature } = await fixture("Auto File", "feat/autofile");
    await git(repo, "checkout", "feat/autofile");
    await commitFile(repo, "hub.txt", "mine\n", "feature edits the hub");
    await git(repo, "checkout", "main");
    await commitFile(repo, "hub.txt", "theirs\n", "main edits the hub");

    await syncFeaturesToBase(project);

    const title = resolutionTaskTitle("feat/autofile", "main");
    const filed = listTasks(project.id).filter((t) => t.title === title);
    expect(filed).toHaveLength(1);
    expect(filed[0].suggested).toBe(1);
    expect(filed[0].feature_id).toBe(feature.id);
    expect(filed[0].description).toContain("git merge main");
    expect(filed[0].description).toContain("hub.txt");

    // A second landing re-detects the same conflict — it must not file twice.
    await commitFile(repo, "other.txt", "y\n", "main moves again");
    await syncFeaturesToBase(project);
    expect(listTasks(project.id).filter((t) => t.title === title)).toHaveLength(1);
  });

  it("dedupes against a resolution task the user already accepted", async () => {
    const { project, feature } = await fixture("Dedupe Accepted", "feat/dedupe");
    const first = fileConflictResolutionTask(project, counted(project.id, feature.id), ["hub.txt"]);
    updateTask(first.task.id, { suggested: 0, status: "in_progress" });

    const second = fileConflictResolutionTask(project, counted(project.id, feature.id), ["hub.txt"]);
    expect(second.existing).toBe(true);
    expect(second.task.id).toBe(first.task.id);
  });

  it("files anew once the previous resolution finished", async () => {
    const { project, feature } = await fixture("Refile", "feat/refile");
    const first = fileConflictResolutionTask(project, counted(project.id, feature.id), ["hub.txt"]);
    updateTask(first.task.id, { status: "done" });

    const second = fileConflictResolutionTask(project, counted(project.id, feature.id), ["hub.txt"]);
    expect(second.existing).toBe(false);
    expect(second.task.id).not.toBe(first.task.id);
  });
});

// ---------------------------------------------------------------- resolve route

describe("POST /api/features/[id]/resolve", () => {
  it("404s on an unknown feature and 400s without a branch", async () => {
    const missing = await resolveRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);

    const project = createProject({ name: "Resolve NoBranch" });
    const feature = createFeature({ project_id: project.id, name: "plain" });
    const nobranch = await resolveRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    expect(nobranch.status).toBe(400);
  });

  it("syncs instead of filing a task when there is no real conflict", async () => {
    // A stale note must not spawn an agent session for a merge git can do.
    const { repo, project, feature } = await fixture("Resolve Clean", "feat/resolveclean");
    updateFeature(feature.id, { sync_conflict: "stale note" });
    await commitFile(repo, "clean.txt", "x\n", "main moved, no overlap");

    const res = await resolveRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string | null };
    expect(body.taskId).toBeNull();
    expect(getFeature(feature.id)!.sync_conflict).toBe("");
    // The branch really did catch up.
    const s = await worktreeSyncStatus({ repoPath: repo, workBranch: "feat/resolveclean", baseBranch: "main" });
    expect(s.behind).toBe(0);
  });

  it("returns the live resolution task instead of stacking a second session", async () => {
    const { repo, project, feature } = await fixture("Resolve Busy", "feat/resolvebusy");
    await git(repo, "checkout", "feat/resolvebusy");
    await commitFile(repo, "hub.txt", "mine\n", "feature side");
    await git(repo, "checkout", "main");
    await commitFile(repo, "hub.txt", "theirs\n", "main side");

    const existing = fileConflictResolutionTask(project, counted(project.id, feature.id), ["hub.txt"]);
    updateTask(existing.task.id, { suggested: 0, started: 1, status: "in_progress" });

    const res = await resolveRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string | null; text: string };
    expect(body.taskId).toBe(existing.task.id);
    expect(body.text).toContain("already");
    // And it did NOT try to relaunch it — started stays as we set it, no new task filed.
    expect(listTasks(project.id).filter((t) => t.title === existing.task.title)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- review fixes
//
// Every case below pins a defect the adversarial review CONFIRMED in the first
// version of this change. They are regression tests in the strictest sense.

describe("catch-up merges are bookkeeping, not work", () => {
  it("the heal fires THROUGH the auto-sync's own merge commits", async () => {
    // The absorbing state: a feature ships outside the route (stamp lost), then
    // a landing on main auto-syncs it — leaving a merge commit raw `ahead`
    // counts. Guarded on raw ahead, the heal could then never fire again.
    const { repo, project, feature } = await fixture("Heal Through", "feat/healthrough");
    createTask({ project_id: project.id, title: "member", feature_id: feature.id });
    updateTask(listTasks(project.id)[0].id, { status: "done" });
    await git(repo, "checkout", "feat/healthrough");
    await commitFile(repo, "work.txt", "x\n", "the work");
    await git(repo, "checkout", "main");
    await landBranch({ repoPath: repo, workBranch: "feat/healthrough", baseBranch: "main", message: "ship outside the route" });
    // Main moves again and the auto-sync catches the (lost-stamp) feature up.
    await commitFile(repo, "other.txt", "y\n", "another landing");
    await syncFeaturesToBase(project);
    expect((await git(repo, "rev-list", "--count", "main..feat/healthrough")).trim()).not.toBe("0"); // raw ahead > 0

    await reconcileFeatureBranch(project, counted(project.id, feature.id));

    expect(getFeature(feature.id)!.merged_at).toBeGreaterThan(0);
  });

  it("the heal refuses while real unlanded work exists", async () => {
    // Pins the guard the mutation analysis showed untested: merged_at=0,
    // done>0, and a genuine commit not on main — must NOT stamp.
    const { repo, project, feature } = await fixture("Heal Refuses", "feat/healrefuse");
    createTask({ project_id: project.id, title: "member", feature_id: feature.id });
    updateTask(listTasks(project.id)[0].id, { status: "done" });
    await git(repo, "checkout", "feat/healrefuse");
    await commitFile(repo, "unlanded.txt", "x\n", "real work not on main");
    await git(repo, "checkout", "main");

    await reconcileFeatureBranch(project, counted(project.id, feature.id));

    expect(getFeature(feature.id)!.merged_at).toBe(0);
  });

  it("archiving is NOT blocked by the sync's own merge commits", async () => {
    // The false alarm: a feature whose only "ahead" is the catch-up merge must
    // archive freely — a guard that cries strand over bookkeeping teaches force.
    const { repo, project, feature } = await fixture("Arch Bookkeeping", "feat/archbook");
    await commitFile(repo, "landed.txt", "x\n", "something lands on main");
    await syncFeaturesToBase(project);
    expect((await git(repo, "rev-list", "--count", "main..feat/archbook")).trim()).not.toBe("0");

    const res = await patchFeature(patchReq({ archived: 1 }), { params: Promise.resolve({ id: feature.id }) });
    expect(res.status).toBe(200);
  });

  it("archiving a SHIPPED feature with post-ship work still warns", async () => {
    // Pins that the guard deliberately has no merged_at exemption — the CH-30
    // strand was on a shipped feature.
    const { repo, project, feature } = await fixture("Arch Shipped", "feat/archshipped");
    updateFeature(feature.id, { merged_at: Date.now() });
    await git(repo, "checkout", "feat/archshipped");
    await commitFile(repo, "late.txt", "x\n", "post-ship work");
    await git(repo, "checkout", "main");

    const res = await patchFeature(patchReq({ archived: 1 }), { params: Promise.resolve({ id: feature.id }) });
    expect(res.status).toBe(409);
  });
});

describe("the resolve route discriminates note species", () => {
  it("refuses a shipped feature and points at Ship again", async () => {
    // Post-ship note: "resolving" would merge main INTO the retired branch and
    // clear a true warning. The remedy is Ship again, and the route says so.
    const { repo, project, feature } = await fixture("Resolve Shipped", "feat/resolveshipped");
    updateFeature(feature.id, { merged_at: Date.now(), sync_conflict: "2 commits landed after it shipped" });
    await git(repo, "checkout", "feat/resolveshipped");
    await commitFile(repo, "late.txt", "x\n", "post-ship work");
    await git(repo, "checkout", "main");

    const res = await resolveRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Ship again");
    // The true warning survives.
    expect(getFeature(feature.id)!.sync_conflict).not.toBe("");
  });

  it("refuses a deleted branch and keeps the warning", async () => {
    // Missing branch reads as the zeroed status ("up to date") — the route must
    // not clear the "no longer exists" note and report success for a ghost.
    const { repo, project, feature } = await fixture("Resolve Gone", "feat/resolvegone");
    updateFeature(feature.id, { sync_conflict: "feat/resolvegone no longer exists in this repo" });
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "feat/resolvegone");

    const res = await resolveRoute(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });

    expect(res.status).toBe(409);
    expect(getFeature(feature.id)!.sync_conflict).toContain("no longer exists");
  });
});

describe("the health sweep stays off retired projects", () => {
  it("does not reconcile features of a deprecated project", async () => {
    const { repo, project, feature } = await fixture("Deprecated Sweep", "feat/depsweep");
    updateFeature(feature.id, { merged_at: Date.now() });
    await git(repo, "checkout", "feat/depsweep");
    await commitFile(repo, "late.txt", "x\n", "post-ship work");
    await git(repo, "checkout", "main");
    updateProject(project.id, { deprecated: 1 });

    await sweepFeatureHealth();

    // Untouched: a retired project's branches are nobody's working set.
    expect(getFeature(feature.id)!.sync_conflict).toBe("");
  });
});
