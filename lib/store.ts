import { nanoid } from "nanoid";
import { getDb } from "./db";
// Capability data comes from the SDK-free lib/agents/capabilities.ts, NOT the
// driver registry — importing the registry here would drag the agent SDKs
// (async Turbopack externals) into every module that touches the store and
// break sync route entries at runtime (see the note in that file).
import { modelContextWindow } from "./agents/capabilities";
import { displayKey, normalizeKey, parseKey, uniqueProjectKey } from "./keys";
import { SERVICE_PORT_BASE } from "./config";
import type { Project, Task, Feature, FeatureWithCounts, Message, PendingMessage, Summary, Session, Priority, Status, MsgRole, TurnUsage, UsageTotals } from "./types";

// ---------- projects ----------

// The single "needs you" predicate (over tasks aliased `t`): a real task,
// in progress, flagged awaiting_input. Deliberately NO running condition — a
// turn parked mid-stream on an AskUserQuestion has running=1 AND
// awaiting_input=1 and needs the user exactly as much as a settled one (the
// client-side isAwaiting in app/orchestrator/format.ts makes the same call).
// Shared by listProjects' awaiting_count subquery, listNeedsYou, and
// countAwaiting so the project badges, the titlebar "N need you" pill, and its
// dropdown can never disagree.
const NEEDS_YOU = "t.suggested = 0 AND t.status = 'in_progress' AND t.awaiting_input = 1";

export function listProjects(): (Project & { task_count: number; last_activity: number; awaiting_count: number; cost_usd: number })[] {
  return getDb()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.suggested = 0) AS task_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${NEEDS_YOU}) AS awaiting_count,
         COALESCE((SELECT SUM(u.cost_usd) FROM task_usage u WHERE u.project_id = p.id), 0) AS cost_usd,
         (SELECT MAX(ts) FROM (
            SELECT MAX(updated_at) AS ts FROM tasks WHERE project_id = p.id
            UNION ALL SELECT MAX(started_at) FROM sessions WHERE project_id = p.id
            UNION ALL SELECT MAX(ended_at) FROM sessions WHERE project_id = p.id
            UNION ALL SELECT MAX(m.created_at) FROM messages m
              JOIN tasks t ON t.id = m.task_id WHERE t.project_id = p.id
          )) AS last_activity
       FROM projects p ORDER BY p.position ASC, p.created_at ASC`
    )
    .all() as (Project & { task_count: number; last_activity: number; awaiting_count: number; cost_usd: number })[];
}

export function getProject(id: string): Project | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}

// The ids of every task with a live turn streaming right now, fleet-wide. The
// client only holds the selected project's tasks, so a turn finishing in a
// project the user has navigated away from is never learned through that
// project's event stream (none is open) nor its task fetch (never refetched) —
// its spinner would stick forever, pinning the client's 10s running-poll on. The
// running-set poller reconciles against this authoritative list so stale
// spinners clear and the poll backs off once nothing is actually running.
export function listRunningTaskIds(): string[] {
  return (
    getDb().prepare("SELECT id FROM tasks WHERE suggested = 0 AND running = 1").all() as { id: string }[]
  ).map((r) => r.id);
}

// Every task across all active projects that's waiting on the user (the shared
// NEEDS_YOU predicate: in_progress with awaiting_input set — including a turn
// still live but parked on an AskUserQuestion) — the rows behind the titlebar
// "N need you" dropdown. `waiting_since` is when Claude last spoke (its final
// message of the paused turn), falling back to the task's updated_at when a task
// is awaiting with no messages yet; the UI renders it as "waiting for <duration>".
// Longest-waiting first, so the most-stale task sits at the top of the list.
export function listNeedsYou(): {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
}[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.title,
         p.name AS project_name, p.color AS project_color, p.icon AS project_icon,
         COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.task_id = t.id), t.updated_at) AS waiting_since
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE ${NEEDS_YOU} AND p.deprecated = 0
       ORDER BY waiting_since ASC`
    )
    .all() as ReturnType<typeof listNeedsYou>;
}

// One project's awaiting count (the shared NEEDS_YOU predicate, same as
// listProjects' awaiting_count subquery and listNeedsYou's rows) — recomputed
// per lifecycle event for the global /api/events stream so clients can patch
// the project badge without refetching the project list.
export function countAwaiting(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND ${NEEDS_YOU}`)
    .get(projectId) as { n: number };
  return row.n;
}

// Lightweight rows for the ⌘K command palette's session search: every real task
// across all active projects, plus just enough of its project to label it. The
// client only holds the selected project's tasks, so the palette fetches this
// fresh each open. Recency order so the empty-query state surfaces what you
// touched last.
export function listAllTasksLite(): {
  id: string;
  project_id: string;
  title: string;
  key: string;
  status: string;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  project_color: string;
  project_icon: string;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.title, t.seq, t.status, t.running, t.awaiting_input, t.updated_at,
         p.key AS project_key, p.name AS project_name, p.color AS project_color, p.icon AS project_icon
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.suggested = 0 AND p.deprecated = 0
       ORDER BY t.updated_at DESC`
    )
    .all() as (ReturnType<typeof listAllTasksLite>[number] & { seq: number; project_key: string })[];
  // Cross-project, so the prefix comes from the join rather than one lookup.
  return rows.map((r) => ({ ...r, key: displayKey(r.project_key, r.seq) }));
}

export function createProject(input: {
  name: string;
  icon?: string;
  sub?: string;
  color?: string;
  context?: string;
  repo_path?: string;
  branch?: string;
}): Project {
  const now = Date.now();
  const id = nanoid();
  const icon = (input.icon || input.name.charAt(0) || "?").toUpperCase().slice(0, 1);
  // New projects sort to the bottom of the sidebar.
  const position = (getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM projects").get() as { n: number }).n;
  // New projects inherit the app-level default agent (Settings → Run defaults);
  // per-project it can then be changed in the Context editor.
  const defaultAgent = getSetting("default_agent") || "claude";
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, default_agent, port, key, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.name, icon, input.sub ?? "", input.color ?? "#C2603C", input.context ?? "", input.repo_path ?? "", input.branch ?? "main", defaultAgent, nextServicePort(), nextProjectKey(input.name), position, now);
  return getProject(id)!;
}

// ---------- keys (lib/keys.ts) ----------

/** The key prefix for a new project: derived from its name, deduped app-wide. */
function nextProjectKey(name: string): string {
  const taken = (getDb().prepare("SELECT key FROM projects WHERE key != ''").all() as { key: string }[]).map((r) => r.key);
  return uniqueProjectKey(name, new Set(taken));
}

/**
 * Claim the next number for a project, for either a task or a feature — one
 * counter serves both, so TME-41 and TME-42 may be one of each, exactly as an
 * issue key works in JIRA.
 *
 * Monotonic: it advances the stored counter rather than reading MAX(seq), so
 * deleting TME-42 cannot hand 42 to the next thing created. Same rule as
 * nextServicePort(), for the same reason — an identifier that gets recycled
 * silently repoints every place it was already written down.
 */
function nextSeq(projectId: string): number {
  const db = getDb();
  db.prepare("UPDATE projects SET key_seq = key_seq + 1 WHERE id = ?").run(projectId);
  return ((db.prepare("SELECT key_seq FROM projects WHERE id = ?").get(projectId) as { key_seq: number } | undefined)?.key_seq) ?? 0;
}

/** One project's key prefix, for building the display keys of its rows. */
const projectKeyOf = (projectId: string): string =>
  (getDb().prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string } | undefined)?.key ?? "";

// The next deterministic per-project port: one past the current max (never
// reusing a freed slot, so a project's port is stable for its lifetime), floored
// at SERVICE_PORT_BASE. Injected as PORT into the project's services + PTY.
export function nextServicePort(): number {
  const maxRow = getDb().prepare("SELECT COALESCE(MAX(port), 0) AS n FROM projects").get() as { n: number };
  return Math.max(maxRow.n, SERVICE_PORT_BASE - 1) + 1;
}

// Persist a new sidebar order. `ids` is the full list of project ids in the
// desired order; each project's position is set to its index.
export function reorderProjects(ids: string[]) {
  const db = getDb();
  const stmt = db.prepare("UPDATE projects SET position = ? WHERE id = ?");
  db.transaction((list: string[]) => list.forEach((id, i) => stmt.run(i, id)))(ids);
}

export function deleteProject(id: string) {
  // Cascades to the project's tasks, messages and summaries (FK ON DELETE CASCADE).
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function updateProject(id: string, patch: Partial<Omit<Project, "id" | "created_at">>): Project | undefined {
  const cur = getProject(id);
  if (!cur) return undefined;
  const n = { ...cur, ...patch };
  getDb()
    .prepare(
      `UPDATE projects SET name = ?, icon = ?, sub = ?, color = ?, context = ?, repo_path = ?, branch = ?,
        dev_command = ?, setup_command = ?, test_command = ?, default_agent = ?, key = ?, deprecated = ? WHERE id = ?`
    )
    // Editing the key re-keys every task and feature in the project at once —
    // the display key is derived, so there is nothing to backfill. Callers
    // validate the shape and uniqueness first (see PATCH /api/projects/[id]).
    .run(n.name, (n.icon || "?").toUpperCase().slice(0, 1), n.sub, n.color, n.context, n.repo_path, n.branch, n.dev_command ?? "", n.setup_command ?? "", n.test_command ?? "", n.default_agent || "claude", normalizeKey(n.key ?? "") || cur.key, n.deprecated ? 1 : 0, id);
  return getProject(id);
}

// Persist "Refresh with AI" job state in isolation. Deliberately separate from
// updateProject (whose fixed column list must NOT touch refresh_* state) so a
// background draft and a concurrent project edit can't clobber each other.
export function setProjectRefresh(
  id: string,
  fields: Partial<Pick<Project, "refresh_status" | "refresh_draft" | "refresh_error" | "refresh_started_at">>,
): Project | undefined {
  const cur = getProject(id);
  if (!cur) return undefined;
  const n = { ...cur, ...fields };
  getDb()
    .prepare(
      `UPDATE projects SET refresh_status = ?, refresh_draft = ?, refresh_error = ?, refresh_started_at = ? WHERE id = ?`
    )
    .run(n.refresh_status, n.refresh_draft, n.refresh_error, n.refresh_started_at, id);
  return getProject(id);
}

// ---------- tasks ----------

// Tasks carry their cumulative spend (cost_usd + total_tokens, summed across all
// turns of every generation) so the chat header can show it without an extra
// call. The two cache buckets ride along because `total_tokens` on its own is
// misleading: in real sessions most of it is prompt-cache READS (context re-sent
// every turn, billed at ~10% of the input rate), so the UI splits the total into
// fresh work vs cached re-reads rather than showing one scary number.
// `context_tokens`/`context_pct` are the LIVE context-window gauge — the
// latest turn's input-side tokens, NOT a cumulative sum (see getTaskContext).
// `depends_on` lists the task ids this task is blocked by (see task_dependencies).
export type TaskWithUsage = Task & {
  key: string; // the rendered "TME-42", derived from the project's key + seq
  cost_usd: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  context_tokens: number;
  context_pct: number;
  depends_on: string[];
};

export function listTasks(projectId: string): TaskWithUsage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.*,
         COALESCE((SELECT SUM(u.cost_usd) FROM task_usage u WHERE u.task_id = t.id), 0) AS cost_usd,
         COALESCE((SELECT SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens)
                   FROM task_usage u WHERE u.task_id = t.id), 0) AS total_tokens,
         COALESCE((SELECT SUM(u.cache_read_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS cache_read_tokens,
         COALESCE((SELECT SUM(u.cache_creation_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS cache_creation_tokens,
         COALESCE((SELECT u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens
                   FROM task_usage u WHERE u.task_id = t.id
                   ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1), 0) AS context_tokens
       FROM tasks t WHERE t.project_id = ?
       ORDER BY t.suggested ASC, t.position ASC, t.created_at ASC`
    )
    .all(projectId) as (Task & {
    cost_usd: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    context_tokens: number;
  })[];
  // Attach each task's dependency edges in one query (project-scoped via join).
  const edges = db
    .prepare(
      `SELECT td.task_id, td.depends_on_id FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?`
    )
    .all(projectId) as { task_id: string; depends_on_id: string }[];
  const byTask = new Map<string, string[]>();
  for (const e of edges) {
    const list = byTask.get(e.task_id);
    if (list) list.push(e.depends_on_id);
    else byTask.set(e.task_id, [e.depends_on_id]);
  }
  // The display key is built here rather than joined in SQL: this query is
  // already project-scoped, so one extra lookup beats a JOIN on every row.
  const pkey = projectKeyOf(projectId);
  return rows.map((r) => ({
    ...r,
    key: displayKey(pkey, r.seq),
    context_pct: contextPct(r.context_tokens, r.agent, r.model),
    depends_on: byTask.get(r.id) ?? [],
  }));
}

// ---------- features (the optional project > feature > task layer) ----------

// A project's features with their progress rollup, in manual order. The counts
// are derived in one grouped subquery rather than stored on the row: a status
// column would need writing from every path that touches tasks.status
// (updateTask, setTaskStatus, the board's reorder, the runner's turn-end
// settle) and would drift the first time one of them was missed.
export function listFeatures(projectId: string): FeatureWithCounts[] {
  const rows = getDb()
    .prepare(
      `SELECT f.*,
         COALESCE(c.total, 0)           AS total,
         COALESCE(c.done, 0)            AS done,
         COALESCE(c.merged_count, 0)    AS merged_count,
         COALESCE(c.running_count, 0)   AS running_count,
         COALESCE(c.suggested_count, 0) AS suggested_count,
         COALESCE(c.awaiting_count, 0)  AS awaiting_count,
         COALESCE(c.blocked_count, 0)   AS blocked_count
       FROM features f
       LEFT JOIN (
         SELECT feature_id,
           SUM(CASE WHEN suggested = 0 AND status != 'cancelled' THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN suggested = 0 AND status  = 'done'      THEN 1 ELSE 0 END) AS done,
           -- Of the total, how many have actually landed. This is what lets a
           -- feature with no integration branch — whose members merge one at a
           -- time — still say truthfully whether it shipped (see featureState).
           SUM(CASE WHEN suggested = 0 AND status != 'cancelled' AND merged_at > 0 THEN 1 ELSE 0 END) AS merged_count,
           SUM(CASE WHEN running = 1                             THEN 1 ELSE 0 END) AS running_count,
           SUM(CASE WHEN suggested = 1                           THEN 1 ELSE 0 END) AS suggested_count,
           SUM(CASE WHEN status = 'in_progress' AND awaiting_input = 1 THEN 1 ELSE 0 END) AS awaiting_count,
           SUM(CASE WHEN blocked_reason != ''                        THEN 1 ELSE 0 END) AS blocked_count
         FROM tasks WHERE feature_id IS NOT NULL GROUP BY feature_id
       ) c ON c.feature_id = f.id
       WHERE f.project_id = ?
       ORDER BY f.position ASC, f.created_at ASC`
    )
    .all(projectId) as FeatureWithCounts[];
  const pkey = projectKeyOf(projectId);
  return rows.map((r) => ({ ...r, key: displayKey(pkey, r.seq) }));
}

export function getFeature(id: string): Feature | undefined {
  return getDb().prepare("SELECT * FROM features WHERE id = ?").get(id) as Feature | undefined;
}

// Resolve a feature reference within one project: an id first, then an exact
// name (UNIQUE(project_id, name) makes that unambiguous), then a case-insensitive
// name. The name paths are what let an agent say `feature: "Billing v2"` without
// ever having seen an id — the same affordance blocked_by gives for task titles.
/**
 * Undo the HTML escaping an agent sometimes applies to a name it is copying
 * back — `A &amp; B` for a feature genuinely called `A & B`.
 *
 * This matters far more than it looks. A name that doesn't match doesn't fail;
 * it AUTO-CREATES (resolveFeature in lib/agentTools.ts, deliberately, so a
 * planner doesn't get twenty errors and file nothing). So one escaped ampersand
 * silently forks a plan into a second feature with no context, no integration
 * branch and autopilot off — and every task filed into it just never runs.
 * Observed twice on one project in two days.
 *
 * `&amp;` is decoded LAST so `&amp;lt;` doesn't round-trip into a literal `<`.
 */
const unescapeName = (s: string) =>
  s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");

/** Comparison key for a feature name: entity-decoded, case- and space-insensitive. */
const nameKey = (s: string) => unescapeName(s).toLowerCase().replace(/\s+/g, " ").trim();

export function findFeature(projectId: string, ref: string): Feature | undefined {
  const key = ref.trim();
  if (!key) return undefined;
  const db = getDb();
  const byId = db.prepare("SELECT * FROM features WHERE id = ? AND project_id = ?").get(key, projectId) as Feature | undefined;
  if (byId) return byId;
  // "TME-42" — but only THIS project's prefix, so another project's key never
  // resolves to a same-numbered feature here (the caller auto-creates on a miss,
  // and a wrong-project hit would be far worse than a new empty feature).
  const parsed = parseKey(key);
  if (parsed && parsed.prefix === normalizeKey(projectKeyOf(projectId))) {
    const byKey = db.prepare("SELECT * FROM features WHERE project_id = ? AND seq = ?").get(projectId, parsed.seq) as Feature | undefined;
    if (byKey) return byKey;
  }
  // Scan rather than match in SQL: the rule is nameKey's, and a project has a
  // handful of features. COLLATE NOCASE only ever covered the case half of it.
  // ponytail: linear scan per lookup, index it if a project ever has hundreds.
  const k = nameKey(key);
  return (db.prepare("SELECT * FROM features WHERE project_id = ?").all(projectId) as Feature[]).find(
    (f) => nameKey(f.name) === k
  );
}

export function createFeature(input: {
  project_id: string;
  name: string;
  description?: string;
  context?: string;
  color?: string;
}): Feature {
  const now = Date.now();
  const id = nanoid();
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM features WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO features (id, project_id, name, description, context, color, seq, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      // Decode on write too: a name with no existing feature to match still
      // shouldn't be STORED as "M1 Tools &amp; Economy" and shown to the user.
      .run(id, input.project_id, unescapeName(input.name).trim(), input.description ?? "", input.context ?? "", input.color ?? "", nextSeq(input.project_id), position, now, now);
  })();
  return getFeature(id)!;
}

export function updateFeature(id: string, patch: Partial<Omit<Feature, "id" | "project_id" | "created_at">>): Feature | undefined {
  const cur = getFeature(id);
  if (!cur) return undefined;
  const n = { ...cur, ...patch, updated_at: Date.now() };
  getDb()
    .prepare(
      `UPDATE features SET name=?, description=?, context=?, color=?, branch=?, base_sha=?, merged_at=?, autopilot=?, pr_url=?, archived=?, position=?, updated_at=? WHERE id=?`
    )
    .run(n.name.trim(), n.description, n.context, n.color, n.branch, n.base_sha, n.merged_at, n.autopilot ?? 0, n.pr_url ?? "", n.archived, n.position, n.updated_at, id);
  return getFeature(id);
}

// Hard-deletes the feature row only. Member tasks survive with feature_id NULL —
// the ON DELETE SET NULL in lib/db.ts is doing that, deliberately (see the
// comment there): removing a grouping must never destroy the work inside it.
export function deleteFeature(id: string) {
  getDb().prepare("DELETE FROM features WHERE id = ?").run(id);
}

export function reorderFeatures(ids: string[]) {
  const db = getDb();
  const stmt = db.prepare("UPDATE features SET position = ? WHERE id = ?");
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id));
  })();
}

// The branch a task bases off and merges into: its feature's integration branch
// when it has one, else the project's. THE single place that resolution happens —
// every merge/sync/PR/worktree path routes through here, so a caller that
// forgets features can't exist.
export function taskBaseBranch(task: Task, project: Project): string {
  if (!task.feature_id) return project.branch;
  return getFeature(task.feature_id)?.branch || project.branch;
}

// Member tasks holding a live worktree. Changing a feature's integration branch
// while any of these exist would silently invalidate their diff base and merge
// target, so the API refuses and names them (see app/api/features/[id]/branch).
export function featureTasksWithWorktrees(featureId: string): { id: string; title: string }[] {
  return getDb()
    .prepare("SELECT id, title FROM tasks WHERE feature_id = ? AND worktree_path != ''")
    .all(featureId) as { id: string; title: string }[];
}

// Member tasks that would be left behind by shipping — not done, not cancelled.
// Advisory only: the ship guard names them, it doesn't lock the button forever.
export function featureUnfinishedTasks(featureId: string): { id: string; title: string }[] {
  return getDb()
    .prepare("SELECT id, title FROM tasks WHERE feature_id = ? AND suggested = 0 AND status NOT IN ('done', 'cancelled')")
    .all(featureId) as { id: string; title: string }[];
}

// Every task filed under a feature, in the project's manual order. Autopilot's
// unit of work — it never looks at ungrouped tasks, because an approved plan is
// always a feature.
export function featureMembers(featureId: string): Task[] {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE feature_id = ? ORDER BY position ASC, created_at ASC")
    .all(featureId) as Task[];
}

/**
 * Members autopilot may start right now: committed (not suggested), not already
 * running, not escalated, not finished or parked, and with every dependency done.
 *
 * The dependency filter is the first consumer `task_dependencies` has ever had.
 * The graph was always writable — `suggest_task({blocked_by})` fills it in and
 * the UI renders it as a badge — but nothing ever scheduled off it, so ordering a
 * planner expressed was ordering the user still had to execute by hand.
 *
 * A dep that doesn't resolve to a done member counts as unmet, which covers the
 * impossible cases safely: setTaskDeps refuses foreign ids on write and the
 * cascade clears them on delete, so an unresolvable dep should never exist — and
 * if one does, refusing to start is the right failure direction.
 */
export function readyMembers(featureId: string): Task[] {
  const members = featureMembers(featureId);
  const done = new Set(members.filter((t) => t.status === "done").map((t) => t.id));
  return members.filter(
    (t) =>
      !t.suggested &&
      !t.running &&
      !t.blocked_reason &&
      t.status !== "done" &&
      t.status !== "cancelled" &&
      t.status !== "on_hold" &&
      getTaskDeps(t.id).every((id) => done.has(id))
  );
}

// The task ids a given task is blocked by.
export function getTaskDeps(taskId: string): string[] {
  return (
    getDb().prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?").all(taskId) as {
      depends_on_id: string;
    }[]
  ).map((r) => r.depends_on_id);
}

// Replace a task's dependency set. Drops self-references and ids outside the
// task's project, then guards against cycles before persisting. Throws on a cycle.
export function setTaskDeps(taskId: string, dependsOn: string[]): void {
  const db = getDb();
  const task = getTask(taskId);
  if (!task) throw new Error("task not found");
  const wanted = [...new Set(dependsOn)].filter((id) => id && id !== taskId);
  const valid = wanted.filter((id) => {
    const t = getTask(id);
    return !!t && t.project_id === task.project_id;
  });
  // Cycle guard: build the would-be graph (taskId's edges replaced by `valid`)
  // and confirm taskId can't reach itself by following depends_on edges.
  const edges = db.prepare("SELECT task_id, depends_on_id FROM task_dependencies").all() as {
    task_id: string;
    depends_on_id: string;
  }[];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.task_id === taskId) continue; // replacing taskId's edges with `valid`
    const list = adj.get(e.task_id);
    if (list) list.push(e.depends_on_id);
    else adj.set(e.task_id, [e.depends_on_id]);
  }
  adj.set(taskId, valid);
  const seen = new Set<string>();
  const stack = [...valid];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) throw new Error("dependency cycle");
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) stack.push(n);
  }
  const now = Date.now();
  db.transaction(() => {
    db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const ins = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)");
    for (const id of valid) ins.run(taskId, id, now);
  })();
}

export function getTask(id: string): Task | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function createTask(input: {
  project_id: string;
  title: string;
  description?: string;
  priority?: Priority;
  suggested?: boolean;
  agent?: string;
  /** Optional grouping. Callers resolve the reference first (see findFeature). */
  feature_id?: string | null;
  // Run config. null/absent = inherit (app default, then the driver's own).
  // Callers are responsible for validating these against the agent's capability
  // descriptor — see validateRun() in lib/agentTools.ts.
  model?: string | null;
  reasoning?: string | null;
}): Task {
  const now = Date.now();
  const id = nanoid();
  // Which agent driver the task runs under: explicit choice, else the owning
  // project's default (see lib/agents/registry.ts for resolution).
  const agent = input.agent || getProject(input.project_id)?.default_agent || "claude";
  // New tasks land at the end of the project's manual order.
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO tasks (id, project_id, feature_id, title, description, priority, status, suggested, agent, model, reasoning, seq, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.project_id, input.feature_id ?? null, input.title, input.description ?? "", input.priority ?? "med", input.suggested ? 1 : 0, agent, input.model ?? null, input.reasoning ?? null, nextSeq(input.project_id), position, now, now);
  })();
  return getTask(id)!;
}

// Persist a manual task ordering (board drag / drop). `ids` is the desired
// order — each task's position is set to its index. The client sends the
// project's full task list flattened in column order; only relative order
// within a status group is ever rendered, so cross-group interleaving is fine.
export function reorderTasks(ids: string[]) {
  const db = getDb();
  const stmt = db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id));
  })();
}

export function updateTask(id: string, patch: Partial<Task>): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const n = { ...cur, ...patch, updated_at: Date.now() };
  getDb()
    .prepare(
      `UPDATE tasks SET feature_id=?, title=?, description=?, priority=?, status=?, suggested=?, agent=?, model=?, resolved_model=?, reasoning=?, permission_mode=?,
        session_id=?, worktree_path=?, work_branch=?, base_sha=?, merged_at=?, pr_url=?, outcome=?, gate_attempts=?, blocked_reason=?, generation=?, started=?, running=?, awaiting_input=?, updated_at=? WHERE id=?`
    )
    .run(n.feature_id ?? null, n.title, n.description, n.priority, n.status, n.suggested, n.agent, n.model ?? null, n.resolved_model ?? null, n.reasoning ?? null, n.permission_mode ?? null, n.session_id, n.worktree_path, n.work_branch, n.base_sha, n.merged_at, n.pr_url, n.outcome ?? "", n.gate_attempts ?? 0, n.blocked_reason ?? "", n.generation, n.started, n.running, n.awaiting_input, n.updated_at, id);
  return getTask(id);
}

export function deleteTask(id: string) {
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function setTaskStatus(id: string, status: Status) {
  return updateTask(id, { status });
}

// Merged tasks that still hold an on-record worktree — the candidates for the
// "prune merged worktrees" cleanup. Joined with the owning project so the API
// can resolve each worktree's repo (for git ops) and label it for the user.
// Whether the directory actually exists on disk is checked by the caller.
export interface PrunableWorktree {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  repo_path: string;
  base_branch: string;
  worktree_path: string;
  work_branch: string;
  merged_at: number;
}
export function listPrunableWorktrees(): PrunableWorktree[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.title, t.project_id, p.name AS project_name, p.repo_path, p.branch AS base_branch,
              t.worktree_path, t.work_branch, t.merged_at
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.merged_at > 0 AND t.worktree_path != ''
        ORDER BY t.merged_at ASC`
    )
    .all() as PrunableWorktree[];
}

// ---------- settings (app-level key/value, readable server-side) ----------

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// A null/empty value clears the key, so it falls back to the built-in default.
export function setSetting(key: string, value: string | null) {
  if (value == null || value === "") {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

// ---------- subscription rate limits ----------
// Claude's SDK emits one rate_limit_event per window (whichever is binding at
// that moment), so a single stored snapshot only ever shows one bar. Keep the
// newest snapshot per window type instead, and Insights renders them together
// the way Claude's own usage panel does. `utilization` is absent until the API
// starts reporting a percentage, so every field but `status` is optional.
export interface RateLimitSnapshot {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  at?: number;
}

export function getRateLimits(): Record<string, RateLimitSnapshot> {
  const raw = getSetting("rate_limit_info");
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    // Installs from before the per-window map stored a single flat snapshot.
    if (typeof v.status === "string") {
      const one = v as unknown as RateLimitSnapshot;
      return { [one.rateLimitType ?? "five_hour"]: one };
    }
    return v as Record<string, RateLimitSnapshot>;
  } catch {
    return {};
  }
}

export function recordRateLimit(info: RateLimitSnapshot): void {
  const all = getRateLimits();
  all[info.rateLimitType ?? "five_hour"] = { ...info, at: Date.now() };
  setSetting("rate_limit_info", JSON.stringify(all));
}

/**
 * Point the seeded Welcome tutorial at a different agent. The tutorial is
 * created at first boot — before onboarding — so its project/tasks carry the
 * 'claude' column defaults; when setup finishes with a different agent connected
 * (a Codex-only first run), the not-yet-started tutorial tasks must follow the
 * agent that actually works. Started tasks keep their agent: a session lineage
 * can't switch CLIs mid-flight.
 */
export function retargetSeededAgent(agent: string): void {
  const db = getDb();
  db.prepare("UPDATE projects SET default_agent = ? WHERE seeded = 1").run(agent);
  db.prepare("UPDATE tasks SET agent = ? WHERE started = 0 AND project_id IN (SELECT id FROM projects WHERE seeded = 1)").run(agent);
}

// ---------- messages ----------

export function listMessages(taskId: string): Message[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(taskId) as Message[];
}

export function addMessage(taskId: string, generation: number, role: MsgRole, content: string): Message {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO messages (id, task_id, generation, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, taskId, generation, role, content, now);
  return { id, task_id: taskId, generation, role, content, created_at: now };
}

export function updateMessage(id: string, content: string) {
  getDb().prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
}

// ---------- pending (queued) messages ----------

// The follow-ups parked behind a running turn for a task, oldest first.
export function listPendingMessages(taskId: string): PendingMessage[] {
  return getDb()
    .prepare("SELECT * FROM pending_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(taskId) as PendingMessage[];
}

// Park a follow-up to run after the current turn ends.
export function addPendingMessage(taskId: string, generation: number, content: string): PendingMessage {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO pending_messages (id, task_id, generation, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, taskId, generation, content, now);
  return { id, task_id: taskId, generation, content, created_at: now };
}

// Atomically claim + remove the oldest parked follow-up for a task (FIFO).
// Returns undefined if the queue is empty. The select+delete run in one
// transaction so two concurrent drains can't pop the same row.
export function popPendingMessage(taskId: string): PendingMessage | undefined {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM pending_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get(taskId) as PendingMessage | undefined;
    if (row) db.prepare("DELETE FROM pending_messages WHERE id = ?").run(row.id);
    return row;
  })();
}

// Remove one parked follow-up by id (the user cancelled it). Scoped by task_id
// so a request against one task can't drop another task's queued message.
// Returns the removed row (so the caller can publish a dequeued event), or
// undefined — including when the id exists but belongs to a different task.
export function deletePendingMessage(id: string, taskId: string): PendingMessage | undefined {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM pending_messages WHERE id = ? AND task_id = ?")
      .get(id, taskId) as PendingMessage | undefined;
    if (row) db.prepare("DELETE FROM pending_messages WHERE id = ?").run(row.id);
    return row;
  })();
}

// Drop the whole parked queue for a task (e.g. the turn was Stopped). Returns
// the removed rows so the caller can clear their bubbles from the transcript.
export function clearPendingMessages(taskId: string): PendingMessage[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = listPendingMessages(taskId);
    if (rows.length) db.prepare("DELETE FROM pending_messages WHERE task_id = ?").run(taskId);
    return rows;
  })();
}

// ---------- summaries ----------

export function listSummaries(taskId: string): Summary[] {
  return getDb()
    .prepare("SELECT * FROM summaries WHERE task_id = ? ORDER BY generation ASC")
    .all(taskId) as Summary[];
}

export function addSummary(taskId: string, generation: number, summary: string): Summary {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO summaries (id, task_id, generation, summary, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, taskId, generation, summary, now);
  return { id, task_id: taskId, generation, summary, created_at: now };
}

// ---------- sessions ----------

export type ProjectSession = Session & { task_title: string; task_status: Status; message_count: number };

// Upsert the session row for a task generation, stamping the live Claude
// session id. Called when a turn opens a session; safe to call on every turn
// of the same generation (resume) — started_at is preserved.
export function recordSession(input: {
  project_id: string;
  task_id: string;
  generation: number;
  claude_session_id: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, project_id, task_id, generation, claude_session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, generation) DO UPDATE SET
         claude_session_id = COALESCE(excluded.claude_session_id, sessions.claude_session_id)`
    )
    .run(nanoid(), input.project_id, input.task_id, input.generation, input.claude_session_id, Date.now());
}

// Mark a generation's session as ended (turn finished). No-op if absent.
export function endSession(taskId: string, generation: number): void {
  getDb()
    .prepare("UPDATE sessions SET ended_at = ? WHERE task_id = ? AND generation = ?")
    .run(Date.now(), taskId, generation);
}

export function listProjectSessions(projectId: string): ProjectSession[] {
  return getDb()
    .prepare(
      `SELECT s.*, t.title AS task_title, t.status AS task_status,
        (SELECT COUNT(*) FROM messages m
           WHERE m.task_id = s.task_id AND m.generation = s.generation
             AND m.role IN ('user', 'assistant', 'tool')) AS message_count
       FROM sessions s JOIN tasks t ON t.id = s.task_id
       WHERE s.project_id = ?
       ORDER BY s.started_at DESC`
    )
    .all(projectId) as ProjectSession[];
}

// ---------- usage ----------

// Persist one turn's token usage + cost. Called once per completed Claude turn
// from the result message. One row per turn keyed (implicitly) by task+generation.
export function addUsage(input: {
  project_id: string;
  task_id: string;
  generation: number;
  agent?: string;
  usage: TurnUsage;
}): void {
  const u = input.usage;
  getDb()
    .prepare(
      `INSERT INTO task_usage
         (id, project_id, task_id, generation, agent, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(), input.project_id, input.task_id, input.generation, input.agent || "claude",
      u.cost_usd, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
      Date.now()
    );
}

// One row per merge that landed commits — see the task_merges schema comment.
export function recordTaskMerge(input: {
  project_id: string;
  task_id: string;
  agent: string;
  additions: number;
  deletions: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO task_merges (id, project_id, task_id, agent, additions, deletions, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nanoid(), input.project_id, input.task_id, input.agent || "claude", input.additions, input.deletions, Date.now());
}

const ZERO_USAGE: UsageTotals = {
  cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, turns: 0,
};

// Sum a usage query into cumulative totals (NULLs → 0 when no rows exist yet).
function sumUsage(where: string, param: string): UsageTotals {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COUNT(*) AS turns
       FROM task_usage WHERE ${where}`
    )
    .get(param) as Omit<UsageTotals, "total_tokens"> | undefined;
  if (!row) return { ...ZERO_USAGE };
  return {
    ...row,
    total_tokens: row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens,
  };
}

export function getTaskUsage(taskId: string): UsageTotals {
  return sumUsage("task_id = ?", taskId);
}

// ---------- context-window occupancy ----------

// Percent (0–100, one decimal) of the model's window that `tokens` occupies.
// The window itself comes from lib/agents/capabilities.ts (modelContextWindow).
function contextPct(tokens: number, agent: string | null | undefined, model: string | null | undefined): number {
  const window = modelContextWindow(agent, model);
  return window > 0 ? Math.round((tokens / window) * 1000) / 10 : 0;
}

export interface TaskContext {
  context_tokens: number; // latest turn's input-side tokens ≈ context sent to the model
  context_window: number; // the model's window (tokens)
  context_pct: number; // context_tokens as a percent (0–100) of the window
}

// The live "how full is the context window" gauge for a task: the most recent
// turn's input-side tokens (input + cache_read + cache_creation), which ≈ the
// size of the context being sent on that turn. Distinct from cumulative spend —
// it reflects the CURRENT occupancy and drops back to ~0 after a /clear. 0 when
// the task has never run a turn.
export function getTaskContext(taskId: string): TaskContext {
  const task = getTask(taskId);
  const row = getDb()
    .prepare(
      `SELECT input_tokens + cache_read_tokens + cache_creation_tokens AS context_tokens
       FROM task_usage WHERE task_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { context_tokens: number } | undefined;
  const context_tokens = row?.context_tokens ?? 0;
  return {
    context_tokens,
    context_window: modelContextWindow(task?.agent, task?.model),
    context_pct: contextPct(context_tokens, task?.agent, task?.model),
  };
}

export function getProjectUsage(projectId: string): UsageTotals {
  return sumUsage("project_id = ?", projectId);
}

// ---------- instance-wide rollup (for the control-plane fleet view) ----------

export interface InstanceUsage extends UsageTotals {
  projects: number;
  tasks: number; // real tasks (suggested excluded), like listProjects' task_count
  running_tasks: number;
  awaiting_tasks: number;
  last_activity: number; // max(task.updated_at); 0 when the instance is empty
}

/**
 * A single-row summary of everything this instance has done, for the control
 * plane to poll and roll up (no per-project fan-out). Cost/tokens are the
 * cumulative sum over task_usage; counts exclude suggested-tray tasks so they
 * match what the user actually sees. Cheap: three aggregate queries, no joins.
 */
export function getInstanceUsage(): InstanceUsage {
  const db = getDb();
  const usage = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COUNT(*) AS turns
       FROM task_usage`
    )
    .get() as Omit<UsageTotals, "total_tokens">;
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM projects) AS projects,
         (SELECT COUNT(*) FROM tasks WHERE suggested = 0) AS tasks,
         (SELECT COALESCE(SUM(running), 0) FROM tasks WHERE suggested = 0) AS running_tasks,
         (SELECT COALESCE(SUM(awaiting_input), 0) FROM tasks WHERE suggested = 0) AS awaiting_tasks,
         (SELECT COALESCE(MAX(updated_at), 0) FROM tasks WHERE suggested = 0) AS last_activity`
    )
    .get() as {
    projects: number;
    tasks: number;
    running_tasks: number;
    awaiting_tasks: number;
    last_activity: number;
  };
  return {
    ...usage,
    total_tokens:
      usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens,
    ...counts,
  };
}

// ---------- insights ----------

/**
 * Everything the Insights dashboard charts, as per-day facts grouped by
 * (day, project, agent) — the client slices/filters/aggregates locally so
 * switching range/project/agent filters never refetches. Days are local-time
 * `YYYY-MM-DD` strings (this is a single-user, local-first surface; the server's
 * clock IS the user's clock). One fetch covers the widest range plus the same
 * width again for prior-period deltas.
 */
export interface InsightsData {
  projects: { id: string; name: string; color: string; deprecated: number }[];
  /** Per-day token/cost usage. */
  usage: { d: string; p: string; a: string; cost: number; inp: number; out: number; cr: number; cw: number }[];
  /** Tasks whose (latest) merge landed that day. */
  shipped: { d: string; p: string; a: string; n: number }[];
  /** Lines landed on the base branch that day (from task_merges). */
  merges: { d: string; p: string; a: string; add: number; del: number }[];
  /** Distinct resolved models seen per agent (for the provider panel). */
  models: { a: string; m: string }[];
}

export function getInsightsData(sinceMs: number): InsightsData {
  const db = getDb();
  const projects = db
    .prepare("SELECT id, name, color, deprecated FROM projects ORDER BY position ASC, created_at ASC")
    .all() as InsightsData["projects"];
  const usage = db
    .prepare(
      `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d, project_id AS p,
              CASE WHEN agent = '' THEN 'claude' ELSE agent END AS a,
              SUM(cost_usd) AS cost, SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
              SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cw
       FROM task_usage WHERE created_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["usage"];
  const shipped = db
    .prepare(
      `SELECT date(merged_at/1000, 'unixepoch', 'localtime') AS d, project_id AS p, agent AS a, COUNT(*) AS n
       FROM tasks WHERE merged_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["shipped"];
  const merges = db
    .prepare(
      `SELECT date(merged_at/1000, 'unixepoch', 'localtime') AS d, project_id AS p, agent AS a,
              SUM(additions) AS "add", SUM(deletions) AS del
       FROM task_merges WHERE merged_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["merges"];
  const models = db
    .prepare(
      `SELECT DISTINCT agent AS a, resolved_model AS m FROM tasks
       WHERE resolved_model IS NOT NULL AND resolved_model != '' AND updated_at >= ?`
    )
    .all(sinceMs) as InsightsData["models"];
  return { projects, usage, shipped, merges, models };
}

// ---------- recaps ----------

// The most recent moment anything happened in a project: task edits, session
// boundaries, or messages. Drives "it's been a while" staleness. 0 = no activity.
export function projectLastActivity(projectId: string): number {
  const row = getDb()
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT MAX(updated_at) AS ts FROM tasks WHERE project_id = @p
         UNION ALL SELECT MAX(started_at) FROM sessions WHERE project_id = @p
         UNION ALL SELECT MAX(ended_at) FROM sessions WHERE project_id = @p
         UNION ALL SELECT MAX(m.created_at) FROM messages m
           JOIN tasks t ON t.id = m.task_id WHERE t.project_id = @p
       )`
    )
    .get({ p: projectId }) as { ts: number | null };
  return row.ts ?? 0;
}

// Whether the project has ever opened a session — i.e. there is anything to recap.
export function projectHasHistory(projectId: string): boolean {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?").get(projectId) as { n: number };
  return row.n > 0;
}

export function setProjectRecap(id: string, recap: string, coversAt: number): void {
  getDb()
    .prepare("UPDATE projects SET recap = ?, recap_at = ?, recap_covers_at = ? WHERE id = ?")
    .run(recap, Date.now(), coversAt, id);
}
