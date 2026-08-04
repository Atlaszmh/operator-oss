// Client-side shapes + UI constants shared across the orchestrator modules.
// Pure data only (no React / no Icon) so any module can import freely.
import type { Priority, Status } from "@/lib/types";

// ---------- client shapes ----------
export interface ProjectRow {
  id: string;
  name: string;
  key: string; // JIRA-style prefix — the "TME" every task and feature key starts with
  icon: string;
  sub: string;
  color: string;
  context: string;
  repo_path: string;
  branch: string;
  dev_command: string;
  setup_command: string;
  test_command: string;
  default_agent: string; // agent driver new tasks in this project default to (lib/agents/registry.ts)
  port: number;
  deprecated: number;
  seeded: number; // 1 = built-in "Welcome" tutorial project (coach marks + post-merge nudge)
  task_count: number;
  last_activity: number;
  awaiting_count: number; // in-progress tasks waiting on the user (across this project)
  cost_usd: number; // cumulative dollar spend across all this project's tasks
}
// The optional project > feature > task layer. Mirrors lib/store.ts
// listFeatures(): the table's columns plus the rollup derived from member tasks.
export interface FeatureRow {
  id: string;
  project_id: string;
  key: string; // "TME-7" — derived server-side from the project's key + seq
  name: string;
  description: string;
  context: string; // prepended to member tasks' sessions, after project context
  color: string; // "" = inherit the project's accent
  branch: string; // integration branch ("" = members use the project branch)
  base_sha: string;
  merged_at: number; // 0 = the integration branch hasn't landed yet
  autopilot: number; // 1 = the approved plan is running unattended (lib/autopilot.ts)
  pr_url: string; // the integration branch's open PR ("" = none); set = waiting on your review
  archived: number; // 1 = hidden from the working set (mirrors project.deprecated)
  position: number;
  total: number; // members that are neither suggested nor cancelled
  done: number; // members with status 'done'
  merged_count: number; // of `total`, those whose branch has landed (drives "shipped")
  running_count: number; // members with a turn streaming right now
  suggested_count: number; // members still in the suggested tray
  awaiting_count: number; // members waiting on the user right now
  blocked_count: number; // members autopilot escalated and stopped working
}
export interface TaskRow {
  id: string;
  project_id: string;
  feature_id: string | null; // optional grouping; null = ungrouped
  key: string; // "TME-42" — derived server-side from the project's key + seq
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number;
  agent: string; // agent driver this task's sessions run under (lib/agents/); fixed for the task's life
  model: string | null;
  resolved_model: string | null;
  reasoning: string | null; // thinking preset; null = inherit default
  permission_mode: string | null; // run permission; null = bypassPermissions (default)
  session_id: string | null;
  pr_url: string; // GitHub PR opened from this task's branch ("" = none yet)
  outcome: string; // one plain-language sentence on what the task delivered ("" = not reported)
  blocked_reason: string; // why autopilot stopped working this task ("" = not blocked)
  generation: number;
  started: number;
  running: number;
  awaiting_input: number;
  updated_at: number;
  cost_usd: number; // cumulative dollar spend across all turns of this task
  total_tokens: number; // cumulative tokens (input+output+cache) across all turns
  cache_read_tokens: number; // of that total, context re-read from the prompt cache (~10% of input price)
  cache_creation_tokens: number; // of that total, context written INTO the cache (fresh work)
  depends_on: string[]; // task ids this task is blocked by until they're done
  context_tokens: number; // latest turn's input-side tokens ≈ current context-window occupancy
  context_pct: number; // context_tokens as a percent (0–100) of the model's window
}
// A single row in the titlebar "need you" dropdown: an awaiting task plus enough
// of its project to label and color it. Mirrors lib/store.ts listNeedsYou().
export interface NeedsYouRow {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
}
// A row in the ⌘K palette's session search: any real task across the active
// projects plus enough of its project to label it. Mirrors lib/store.ts
// listAllTasksLite().
export interface PaletteTaskRow {
  id: string;
  project_id: string;
  title: string;
  key: string; // "TME-42" — also part of the palette's fuzzy match text
  status: Status;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  project_color: string;
  project_icon: string;
}
export interface Msg {
  id: string;
  // "queued" is a client-only role: a follow-up the user typed mid-turn that's
  // parked (in pending_messages) until the current turn ends. Not a persisted
  // message role — it never lands in the `messages` table.
  role: "user" | "assistant" | "tool" | "system" | "session_break" | "queued";
  content: string;
  generation: number;
  toolId?: string; // tool_use id, for merging the tool_result that arrives later
}
export interface ProjectSession {
  id: string;
  task_id: string;
  task_title: string;
  task_status: Status;
  generation: number;
  claude_session_id: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
}
export interface RecapInfo {
  recap: string | null;
  recap_at: number;
  hasHistory: boolean;
  stale: boolean;
  needsRecap: boolean;
  generating: boolean;
  lastActivity: number;
  // Client-side only: set when the fetch/generate failed, so the landing pane
  // can offer a retry instead of silently showing nothing.
  error?: string;
}

// Divergence of a feature's integration branch from the project branch, plus
// what shipping it would hit (GET /api/features/:id/branch). `worktreeBlockers`
// is non-empty when member tasks hold live worktrees, which freezes the branch
// setting; `unfinished` is the advisory ship guard.
export interface FeatureBranchResp {
  branch: string;
  baseBranch: string;
  merged_at: number;
  behind?: number;
  ahead?: number;
  canFastForward?: boolean;
  clean?: boolean;
  conflicts?: string[];
  worktreeBlockers: { id: string; title: string }[];
  unfinished: { id: string; title: string }[];
}

// Divergence status for the reopened-task sync banner (GET /api/tasks/:id/sync).
export interface SyncStatusResp {
  isolated: boolean;
  baseBranch?: string;
  behind?: number;
  ahead?: number;
  isDirty?: boolean;
  canFastForward?: boolean;
  clean?: boolean;
  conflicts?: string[];
}

export type FsListing = { path: string; parent: string | null; home: string; entries: { name: string; path: string }[] };

// ---------- GitHub onboarding shapes ----------
export type GhStatusT = { installed: boolean; authenticated: boolean; login: string | null };
export type GhLoginT = { status: "idle" | "starting" | "awaiting" | "success" | "error"; code: string | null; url: string | null; user: string | null; error: string | null };
export type GhRepoT = { nameWithOwner: string; description: string; isPrivate: boolean; updatedAt: string };

// ---------- first-run onboarding wizard shapes ----------
export type OnbStep = "connect" | "verify";
export type OnboardingT = {
  complete: boolean;
  step: OnbStep;
  method: "subscription" | "api_key" | null;
  account: { email: string | null; plan: string | null } | null;
};
export type ClaudeLoginT = {
  status: "idle" | "starting" | "awaiting" | "submitting" | "success" | "error";
  url: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
  log: string;
};
export type ClaudeVerifyT = {
  connected: boolean;
  email: string | null;
  plan: string | null;
  method: string | null;
  error: string | null;
};

// ---------- multi-agent connect (GET /api/agents + /api/agents/[id]/*) ----------
// Mirrors the server's AgentCapabilities + per-agent connection state. Used by
// the Settings "Agents" surface to render connect cards and gray out agents that
// aren't wired up. Only the fields the client reads are typed here.
export type AgentCapabilitiesT = {
  apiKeyHint: string | null;
  loginStyle: "paste_code" | "device_code";
};
export type AgentInfoT = {
  id: string;
  label: string;
  capabilities: AgentCapabilitiesT;
  connected: boolean;
  account: { email: string | null; plan: string | null; method: "subscription" | "api_key" } | null;
  authBroken?: AgentAuthBrokenT | null;
};
// Connected, but its login stopped working mid-flight (see lib/authFailure.ts).
// `reason` is the provider's own error text; `at` is when it was first seen.
export type AgentAuthBrokenT = { at: number; reason: string };
export type AgentsResponseT = { default: string; agents: AgentInfoT[] };
export type AgentLoginT = ClaudeLoginT & { code?: string | null };

// ---------- status maps (DB status -> design's r/a/g classes + labels) ----------
export const SCLS: Record<Status, "r" | "a" | "g" | "h" | "x"> = { not_started: "r", in_progress: "a", on_hold: "h", done: "g", cancelled: "x" };
export const SLABEL: Record<Status, string> = { not_started: "Not started", in_progress: "In progress", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
export const AWAIT_LABEL = "Needs your input";
export const SSUB: Record<Status, string> = { not_started: "no session yet", in_progress: "session active or paused", on_hold: "paused — pick up later", done: "work complete / merged", cancelled: "abandoned — won't be finished" };
export const STATUSES: Status[] = ["not_started", "in_progress", "on_hold", "done", "cancelled"];
export const PLABEL: Record<Priority, string> = { hi: "High", med: "Medium", lo: "Low" };
export const PRIORITIES: Priority[] = ["hi", "med", "lo"];

// ---------- agent capability descriptors (mirrors lib/agents/types.ts) ----------
// The run controls are no longer hardcoded per agent: each driver ships a
// capability descriptor (models / reasoning / permission modes it supports, plus
// feature flags) served by GET /api/agents. The client renders every picker from
// this data, so a task's controls always match the agent it runs under.
// `tier` is server-side only (it drives the suggest_task routing guidance in
// lib/agents/shared.ts); it's mirrored here so the next person diffing the two
// interfaces doesn't find a phantom drift.
export interface AgentModelOption { value: string; label: string; sub: string; contextWindow: number; group?: string; tier?: "light" | "standard" | "heavy" | "max" }
export interface AgentPickerOption { value: string; label: string; sub: string }
export interface AgentCapabilities {
  models: AgentModelOption[];
  reasoningOptions: AgentPickerOption[];
  permissionModes: AgentPickerOption[];
  supportsAsks: boolean;      // can surface interactive ask cards mid-turn
  supportsMcpTools: boolean;  // can mount the orchestrator MCP tools
  reportsCostUsd: boolean;    // usage carries a real dollar cost (not just tokens)
  costIsEstimated: boolean;   // cost is estimated from tokens × API prices — show with ~
  supportsResume: boolean;    // turns can resume a prior session/thread id
}
// How this agent is signed in. "subscription" (a Max/Pro or ChatGPT login) means
// turns draw on plan quota and cost no marginal money, so a dollar figure is an
// API-PRICE EQUIVALENT rather than a charge; "api_key" means it really is billed.
// Mirrors lib/agents/connections.ts AgentConnection; null when not connected.
export interface AgentAccount { email: string | null; plan: string | null; method: "subscription" | "api_key" }
export interface AgentInfo { id: string; label: string; capabilities: AgentCapabilities; authenticated: boolean; account?: AgentAccount | null; authBroken?: AgentAuthBrokenT | null }
export interface AgentsBundle { default: string; agents: AgentInfo[] }
export const EMPTY_AGENTS: AgentsBundle = { default: "claude", agents: [] };

// A picker option list. `value: null` is the synthetic "Default" head — it
// persists as null in tasks.model/reasoning/permission_mode, inheriting the
// app-level (agent-scoped) default, then the driver's built-in.
export type PickerOption = { value: string | null; label: string; sub: string; group?: string };
const DEFAULT_HEAD: PickerOption = { value: null, label: "Default", sub: "inherit the agent's default" };
const withDefault = (opts: PickerOption[]): PickerOption[] => [DEFAULT_HEAD, ...opts];
// Build each picker's option list from a driver's capabilities. Undefined caps
// (agent metadata not loaded yet) yields just the Default head.
export const modelOptions = (caps?: AgentCapabilities): PickerOption[] => withDefault(caps?.models ?? []);
export const reasoningOptions = (caps?: AgentCapabilities): PickerOption[] => withDefault(caps?.reasoningOptions ?? []);
export const permissionOptions = (caps?: AgentCapabilities): PickerOption[] => withDefault(caps?.permissionModes ?? []);

// Lightweight filter box for the project & task lists — only worth showing once a
// list grows past SEARCH_MIN, so small workspaces stay clutter-free.
export const SEARCH_MIN = 6;

// How a project's tasks render: the grouped list (middle column + chat), or
// the full-workspace kanban board. Persisted alongside the other prefs.
export type TaskView = "list" | "board";

// Which surface fills the work area (the right two columns). "workspace" is the
// normal tasks+session view; "settings" replaces it with the app settings shell;
// "insights" with the usage/analytics dashboard. Mirrored into the URL
// (?view=settings / ?view=insights) so it's deep-linkable + refresh-stable,
// consistent with how project/task selection is persisted.
export type View = "workspace" | "settings" | "insights";
// Purely cosmetic, client-only look-and-feel prefs (the "Appearance" panel).
export interface Appearance { theme: "light" | "dark"; density: string; }
export const DEFAULT_APPEARANCE: Appearance = { theme: "dark", density: "1" };

// App-level preferences (distinct from Appearance, which is purely cosmetic). These
// are personal/client-only so they live in the same localStorage store as Appearance;
// if shared/server config is ever needed, a `settings` table in lib/db.ts keyed by
// name would be the place. Keep this a flat object with sensible defaults so new
// settings are a one-line addition here + a field in SettingsView.
export interface Settings {
  // The app nudges you to /clear when a session's context window crosses EITHER
  // of these — a percentage of the window, or an absolute token count. The paired
  // "Recommend /clear when context is high" feature reads these.
  clearThresholdPct: number;    // 0–100, % of the context window
  clearThresholdTokens: number; // absolute token count
}
export const DEFAULT_SETTINGS: Settings = { clearThresholdPct: 75, clearThresholdTokens: 150_000 };

// Persisted sidebar layout — column widths and collapsed (hidden) state, so the
// user can carve out more room for the chat and have it stick across reloads.
export interface Layout { projW: number; taskW: number; railW: number; projCollapsed: boolean; taskCollapsed: boolean; railCollapsed: boolean; }
export const DEFAULT_LAYOUT: Layout = { projW: 236, taskW: 352, railW: 430, projCollapsed: false, taskCollapsed: false, railCollapsed: false };
export const PROJ_W = { min: 170, max: 460 };
export const TASK_W = { min: 240, max: 620 };
export const RAIL_W = { min: 320, max: 760 };
