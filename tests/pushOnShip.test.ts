import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createProject, createFeature, updateFeature, getFeature } from "@/lib/store";
import { createFeatureBranch, pushBranch, hasOrigin } from "@/lib/git";
import { publishProjectBranch } from "@/lib/featureSync";
import { POST as shipRoute } from "@/app/api/features/[id]/ship/route";
import { git, makeRepo, commitFile, tmpDir } from "./helpers";

// Push-on-ship is the one step in the flow that leaves the machine, so it is
// flagged off by default and — critically — can never fail the merge that
// triggered it. These pin both halves.

const FLAG = "ORCH_FEATURE_PUSH_ON_SHIP";
const setFlag = (v: string | undefined) => {
  if (v === undefined) delete process.env[FLAG];
  else process.env[FLAG] = v;
};
beforeEach(() => setFlag(undefined));
afterEach(() => setFlag(undefined));

/** A repo whose `origin` is a real bare repo on disk, so pushes actually push. */
async function repoWithOrigin() {
  const repo = await makeRepo();
  const remote = tmpDir("remote-");
  await git(remote, "init", "--bare", "-b", "main");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  return { repo, remote };
}

const remoteTip = (remote: string) => git(remote, "rev-parse", "main");

describe("pushBranch", () => {
  it("pushes to a real origin", async () => {
    const { repo, remote } = await repoWithOrigin();
    await commitFile(repo, "new.txt", "x\n", "local work");
    expect(await remoteTip(remote)).not.toBe(await git(repo, "rev-parse", "main"));

    const res = await pushBranch(repo, "main");

    expect(res.ok).toBe(true);
    expect(await remoteTip(remote)).toBe(await git(repo, "rev-parse", "main"));
  });

  it("reports a missing origin as skipped, never throws", async () => {
    const repo = await makeRepo();
    expect(await hasOrigin(repo)).toBe(false);
    const res = await pushBranch(repo, "main");
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it("reports a rejected push instead of forcing it", async () => {
    // The remote holds work this clone hasn't seen — resolving that is a
    // fetch-and-merge decision, never something to paper over with --force.
    const { repo, remote } = await repoWithOrigin();
    const other = tmpDir("other-");
    await git(other, "clone", remote, ".");
    await commitFile(other, "theirs.txt", "them\n", "someone else pushed");
    await git(other, "push", "origin", "main");
    const remoteBefore = await remoteTip(remote);

    await commitFile(repo, "mine.txt", "me\n", "my work");
    const res = await pushBranch(repo, "main");

    expect(res.ok).toBe(false);
    expect(res.skipped).toBeUndefined();
    // The remote is untouched — no force, no clobber.
    expect(await remoteTip(remote)).toBe(remoteBefore);
  });
});

describe("publishProjectBranch", () => {
  it("does nothing at all while the flag is off", async () => {
    const { repo, remote } = await repoWithOrigin();
    const project = createProject({ name: "Flag Off", repo_path: repo, branch: "main" });
    await commitFile(repo, "work.txt", "x\n", "unpublished work");
    const before = await remoteTip(remote);

    const res = await publishProjectBranch(project);

    expect(res.pushed).toBe(false);
    expect(res.note).toBe("");
    expect(await remoteTip(remote)).toBe(before); // still local-only
  });

  it("pushes and says so when the flag is on", async () => {
    setFlag("1");
    const { repo, remote } = await repoWithOrigin();
    const project = createProject({ name: "Flag On", repo_path: repo, branch: "main" });
    await commitFile(repo, "work.txt", "x\n", "work to publish");

    const res = await publishProjectBranch(project);

    expect(res.pushed).toBe(true);
    expect(res.note).toContain("Pushed main");
    expect(await remoteTip(remote)).toBe(await git(repo, "rev-parse", "main"));
  });

  it("reports a failure without throwing, and says the merge still landed", async () => {
    setFlag("1");
    const repo = await makeRepo(); // no origin at all
    const project = createProject({ name: "No Remote", repo_path: repo, branch: "main" });

    const res = await publishProjectBranch(project);

    expect(res.pushed).toBe(false);
    expect(res.note).toContain("origin");
    expect(res.note).toContain("landed locally");
  });
});

describe("the ship route publishes what it landed", () => {
  async function shippableFeature(name: string, branch: string) {
    const { repo, remote } = await repoWithOrigin();
    const project = createProject({ name, repo_path: repo, branch: "main" });
    const feature = createFeature({ project_id: project.id, name: `${name} feature` });
    const cut = await createFeatureBranch(repo, branch, "main");
    updateFeature(feature.id, { branch, base_sha: cut!.sha });
    await git(repo, "checkout", branch);
    await commitFile(repo, "shipped.txt", "the work\n", "feature work");
    await git(repo, "checkout", "main");
    return { repo, remote, project, feature: getFeature(feature.id)! };
  }

  it("leaves origin untouched with the flag off", async () => {
    const { remote, feature } = await shippableFeature("Ship NoPush", "feat/nopush");
    const before = await remoteTip(remote);

    const res = await shipRoute(new Request("http://x?force=1", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    const body = (await res.json()) as { ok: boolean; pushed: boolean; text: string };

    expect(body.ok).toBe(true);
    expect(body.pushed).toBe(false);
    expect(await remoteTip(remote)).toBe(before);
  });

  it("pushes main and reports it with the flag on", async () => {
    setFlag("1");
    const { repo, remote, feature } = await shippableFeature("Ship Push", "feat/push");

    const res = await shipRoute(new Request("http://x?force=1", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    const body = (await res.json()) as { ok: boolean; pushed: boolean; text: string };

    expect(body.ok).toBe(true);
    expect(body.pushed).toBe(true);
    expect(body.text).toContain("Pushed main to origin");
    // The ship merge really is on the remote now.
    expect(await remoteTip(remote)).toBe(await git(repo, "rev-parse", "main"));
    expect(await git(remote, "log", "--format=%s", "main")).toContain("feature work");
  });

  it("still ships, and says so, when the push fails", async () => {
    // The merge is local and already committed — an unreachable remote must not
    // turn a successful ship into a failure.
    setFlag("1");
    const { repo, feature } = await shippableFeature("Ship PushFail", "feat/pushfail");
    // Point origin at a path that isn't a repo.
    const dead = tmpDir("dead-");
    fs.rmSync(dead, { recursive: true, force: true });
    await git(repo, "remote", "set-url", "origin", dead);

    const res = await shipRoute(new Request("http://x?force=1", { method: "POST" }), {
      params: Promise.resolve({ id: feature.id }),
    });
    const body = (await res.json()) as { ok: boolean; pushed: boolean; text: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pushed).toBe(false);
    expect(body.text).toContain("Shipped");
    expect(body.text).toContain("will push with the next successful one");
    // And the ship itself is intact.
    expect(getFeature(feature.id)!.merged_at).toBeGreaterThan(0);
    expect(await git(repo, "log", "--format=%s", "main")).toContain("feature work");
  });
});
