// Task detail + transcript (GET) and field edits (PATCH: title, description,
// priority, status, model, reasoning, depends_on, feature_id). DELETE is not
// mirrored — it tears down the worktree, and that stays a UI act.
export const dynamic = "force-dynamic";
export { GET, PATCH } from "@/app/api/tasks/[id]/route";
