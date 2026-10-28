// Project detail with its tasks and features (GET), and settings edits (PATCH:
// test_command, setup_command, dev_command, context, branch, …). DELETE is not
// mirrored. See ../route.ts for why these mirrors exist.
export const dynamic = "force-dynamic";
export { GET, PATCH } from "@/app/api/projects/[id]/route";
