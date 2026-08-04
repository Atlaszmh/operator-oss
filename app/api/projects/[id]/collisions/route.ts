import { NextResponse } from "next/server";
import { getProject, listTasks } from "@/lib/store";
import { branchCollisions } from "@/lib/git";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// How many in-flight branches to compare. Pairwise is O(n²) git invocations, and
// past a couple of dozen live tasks the answer stops being actionable anyway —
// the point is "these two will fight", not a full dependency matrix.
const MAX_BRANCHES = 24;

// Which of a project's in-flight tasks would conflict WITH EACH OTHER.
//
// The existing per-task sync endpoint answers "does this branch conflict with
// the base". That misses the failure that actually stalls a queue: two tasks
// that each merge the base cleanly but not each other. Nothing surfaced that
// until the second merge attempt, long after both agents had done the work.
//
// Read-only — merge-tree predicts without touching any working tree.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!project.repo_path) return NextResponse.json({ collisions: [], tasks: [] });

  // In flight = started, has a branch, not yet merged, not cancelled. A merged
  // task's branch is already reconciled; a suggestion has no branch at all.
  const live = listTasks(project.id).filter(
    (t) => t.work_branch && !t.merged_at && t.started && t.status !== "cancelled"
  );
  const capped = live.slice(0, MAX_BRANCHES);
  const byBranch = new Map(capped.map((t) => [t.work_branch, t]));

  const collisions = await branchCollisions(
    project.repo_path,
    capped.map((t) => t.work_branch)
  );

  return NextResponse.json({
    // Reported so a truncated answer can never read as "nothing collides".
    scanned: capped.length,
    skipped: live.length - capped.length,
    collisions: collisions.map((c) => ({
      files: c.files,
      a: { id: byBranch.get(c.a)?.id ?? null, title: byBranch.get(c.a)?.title ?? c.a, branch: c.a },
      b: { id: byBranch.get(c.b)?.id ?? null, title: byBranch.get(c.b)?.title ?? c.b, branch: c.b },
    })),
  });
}
