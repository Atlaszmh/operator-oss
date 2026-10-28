// Send a prompt into a task's session: starts or resumes a turn, or queues the
// message if one is already running (202 {queued: true}). The SSE GET is not
// mirrored — poll the task GET for the transcript instead.
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export { POST } from "@/app/api/tasks/[id]/messages/route";
