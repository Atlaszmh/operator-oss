import { NextResponse } from "next/server";
import { getProject, updateProject, deleteProject } from "@/lib/store";
import { listTasks, listFeatures, listProjects } from "@/lib/store";
import { normalizeKey, validateKey } from "@/lib/keys";
import { removeWorktree } from "@/lib/git";
import { removeTaskUploads } from "@/lib/uploads";
import { abortTurn } from "@/lib/abort";
import { removeProjectServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Features ride along with the tasks: the client refreshes this one endpoint
  // after every task mutation, so bundling them keeps the rollup counts in step
  // with the task list they describe without a second fetch to race against.
  return NextResponse.json({ ...project, tasks: listTasks(id), features: listFeatures(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json();
  // The key is the one field with app-wide constraints (shape + uniqueness), so
  // it's checked here rather than in updateProject: the store writes whatever
  // it's given, and a duplicate key would silently make two projects' tasks
  // share an identifier. Changing it re-keys every task and feature at once —
  // that's intended, and the UI says so.
  if (typeof patch.key === "string") {
    const invalid = validateKey(patch.key);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    const key = normalizeKey(patch.key);
    const clash = listProjects().find((p) => p.id !== id && p.key.toUpperCase() === key);
    if (clash) return NextResponse.json({ error: `${key} is already ${clash.name}'s key.` }, { status: 409 });
    patch.key = key;
  }
  const project = updateProject(id, patch);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(project);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tasks = listTasks(id);
  // Stop any in-flight turns BEFORE the cascade drops their task rows. A live
  // turn keeps writing to SQLite (addMessage, updateTask); once its row is gone
  // those writes hit a FOREIGN KEY error, and the second such throw (from the
  // error handler re-persisting) escapes the runner and, unhandled, would take
  // down the whole server process — killing every other tenant's turn. Mirror
  // the task DELETE handler, which aborts before teardown for the same reason.
  for (const t of tasks) abortTurn(t.id);
  // Tear down each task's worktree + uploaded chat images before the DB
  // cascade drops the rows.
  for (const t of tasks) {
    if (project.repo_path && t.worktree_path) await removeWorktree(project.repo_path, t.worktree_path, t.work_branch);
    removeTaskUploads(t.id);
  }
  // Kill this project's managed dev-server processes and drop their live registry
  // entries BEFORE the cascade drops the services rows — otherwise the detached
  // children leak (holding the project's port) and the public <slug>--<host>
  // router keeps routing to a now-deleted project until the server restarts.
  removeProjectServices(id);
  deleteProject(id);
  return NextResponse.json({ ok: true });
}
