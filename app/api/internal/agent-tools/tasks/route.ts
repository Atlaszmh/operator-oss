// Every real task across active projects (key, status, running, awaiting_input).
// See ../projects/route.ts for why these mirrors exist. POST deliberately not
// exposed — filing goes through suggest-task so it lands in the tray.
export const dynamic = "force-dynamic";
export { GET } from "@/app/api/tasks/route";
