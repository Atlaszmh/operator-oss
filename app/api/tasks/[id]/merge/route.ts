import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, recordTaskMerge, taskBaseBranch } from "@/lib/store";
import { mergeTask } from "@/lib/git";
import { syncFeaturesToBase, syncTasksToBase, publishProjectBranch } from "@/lib/featureSync";
import { track } from "@/lib/analytics";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The whole check-then-commit sequence runs under the per-task lock shared
  // with the turn-launch path (messages route + queue drain), making the
  // running check atomic with the git operation: a turn can't start writing
  // into the worktree while `git add -A` + commit are staging it.
  return jsonGuard(`merge ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running — wait for the session to finish before merging" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated branch to merge" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const result = await mergeTask({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: taskBaseBranch(task, project),
      message: `${task.title} (orchestrator task ${task.id})`,
    });

    if (result.ok) {
      // Funnel: the first merge in the seeded Welcome project is the tutorial's
      // aha moment — the last onboarding step. Re-merges don't re-count.
      if (project.seeded && !task.merged_at)
        track("onboarding_step_completed", { step: "tutorial_project", task_id: task.id });
      // Record the merge and advance the diff base to the merged tip so a later
      // round in the same task shows only changes made after this merge. Status
      // is deliberately NOT changed — merging is a git action, not a declaration
      // that the task is finished. The user owns the "done" status (you may merge
      // several rounds while still iterating). They mark it done manually.
      updateTask(id, {
        merged_at: Date.now(),
        ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
      });
      // Insights: persist what this merge landed (line stats die with the
      // worktree, so merge time is the only chance). Re-merges that landed
      // nothing (alreadyMerged) don't record.
      if (!result.alreadyMerged)
        recordTaskMerge({
          project_id: project.id, task_id: id, agent: task.agent,
          additions: result.additions ?? 0, deletions: result.deletions ?? 0,
        });
      if (!result.alreadyMerged) {
        // Sibling tasks on the same base are the ones racing this merge — catch
        // them up now, not at each one's next turn, so the next to land meets a
        // conflict the size of THIS change rather than of the whole race.
        await syncTasksToBase(project, result.targetBranch, { except: id });
        // A task whose base IS the project branch (ungrouped, or in a feature
        // with no integration branch) moves that branch just as a ship does — so
        // the feature-level catch-up applies too. Keyed off what actually
        // landed rather than off the task's shape, so there is one rule and no
        // second place to forget it.
        if (result.targetBranch === project.branch) {
          await syncFeaturesToBase(project);
          // Same rule as a ship: the project branch moved, so publish it.
          await publishProjectBranch(project);
        }
      }
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }));
}
