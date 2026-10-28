// Read-only mirrors for a caller with no browser — a Claude Code session on the
// host that plans and coordinates outside Operator (skills/operator-sessions).
// On an Access-gated instance /api/projects needs a JWT; this prefix takes the
// instance SERVICE_TOKEN instead (middleware.ts, isAgentToolPath). Same handler
// as the UI's, so the shape never drifts. POST (create) deliberately not exposed.
export const dynamic = "force-dynamic";
export { GET } from "@/app/api/projects/route";
