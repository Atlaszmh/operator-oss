"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { isAwaiting, modelLabel, relTime, featureState, isFinished, FEATURE_STATE_LABEL } from "./format";
import { SLABEL, AWAIT_LABEL, SEARCH_MIN, STATUSES, type ProjectRow, type TaskRow, type FeatureRow, type AgentsBundle, type TaskView } from "./types";
import { agentLabel, capsFor } from "./agents";
import { StatusDot, PriPill, SearchBar, AgentBadge, FeatureChip } from "./shared";
import { TaskCardSkeleton } from "./Layout";
import { TaskBoard } from "./TaskBoard";

function TaskCard({ task, agents, selected, running, blockedBy, onSelect, featureName, featureColor, onOpenFeature }: { task: TaskRow; agents: AgentsBundle; selected: boolean; running: boolean; blockedBy?: string[]; onSelect: () => void; featureName?: string; featureColor?: string; onOpenFeature?: () => void }) {
  const sessionCount = task.started ? task.generation : Math.max(0, task.generation - 1);
  const awaiting = isAwaiting(task);
  const blocked = !!blockedBy?.length && !task.started;
  // Awaiting wins over running: a turn parked on a question is live but really
  // waiting on you, so it should read "waiting", not "working".
  const activity = awaiting ? `waiting on you · ${relTime(task.updated_at)}`
    : running ? "live · working"
    : task.status === "done" ? `done · ${relTime(task.updated_at)}`
    : task.status === "cancelled" ? `cancelled · ${relTime(task.updated_at)}`
    : task.started ? relTime(task.updated_at) : "not started";
  return (
    <button className={`task ${selected ? "sel" : ""} ${awaiting ? "awaiting" : ""}`} onClick={onSelect}>
      <div className="task-top">
        <StatusDot status={task.status} running={running} awaiting={awaiting} />
        {task.key && <span className="key-chip">{task.key}</span>}
        <span className="ttitle">{task.title}</span>
        <span className={`slabel ${awaiting ? "await" : ""}`}>{awaiting ? AWAIT_LABEL : SLABEL[task.status]}</span>
        <AgentBadge label={agentLabel(agents, task.agent)} multi={agents.agents.length > 1} />
        {/* Its own span, not a prop on AgentBadge — that renders null on
            single-agent installs and would take the model badge with it. */}
        {task.model && <span className="model-badge" title={`Runs on ${modelLabel(task.model, capsFor(agents, task.agent))}`}>{modelLabel(task.model, capsFor(agents, task.agent))}</span>}
        <PriPill p={task.priority} />
      </div>
      {/* Only rendered where the surrounding list ISN'T already grouped by
          feature — inside a feature group the chip would repeat its own header
          on every row. The caller decides by passing featureName or not. */}
      {featureName && (
        <div className="task-feat"><FeatureChip name={featureName} color={featureColor} onClick={onOpenFeature} /></div>
      )}
      {blocked && (
        <div className="blocked-chip" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} Blocked by {blockedBy!.length === 1 ? blockedBy![0] : `${blockedBy!.length} tasks`}
        </div>
      )}
      {task.description && <div className="tdesc">{task.description}</div>}
      {/* What the task DELIVERED, in the agent's own words — the whole point is
          reading it off the card instead of opening the transcript. Rendered
          whenever it exists, not only on done tasks: a long task that already
          reported one is exactly where the glance pays off. */}
      {task.outcome && <div className="toutcome" title={task.outcome}>{Icon.check()}<span>{task.outcome}</span></div>}
      <div className="task-foot">
        <span className="activity">{awaiting ? <span style={{ color: "var(--blue)" }}>●</span> : running ? <span style={{ color: "var(--amber)" }}>●</span> : null}{activity}</span>
        <span className="spacer" />
        {sessionCount > 0 && <span className="activity">{sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>}
      </div>
    </button>
  );
}

// `featureOf` is passed only by groups that sit OUTSIDE the feature sections —
// "Needs your input" pulls awaiting tasks out of their feature, so without the
// chip you'd lose track of which feature the blocked work belongs to.
function TaskGroup({ label, tasks, agents, selTaskId, running, blockedBy, onSelect, accent, collapsible, collapsed, onToggle, featureOf, onOpenFeature }: { label: string; tasks: TaskRow[]; agents: AgentsBundle; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; onSelect: (id: string) => void; accent?: boolean; collapsible?: boolean; collapsed?: boolean; onToggle?: () => void; featureOf?: (t: TaskRow) => FeatureRow | undefined; onOpenFeature?: (id: string) => void }) {
  if (tasks.length === 0) return null;
  const card = (t: TaskRow) => {
    const f = featureOf?.(t);
    return (
      <TaskCard
        key={t.id} task={t} agents={agents} selected={t.id === selTaskId}
        running={running.has(t.id)} blockedBy={blockedBy.get(t.id)} onSelect={() => onSelect(t.id)}
        featureName={f?.name} featureColor={f?.color || undefined}
        onOpenFeature={f && onOpenFeature ? () => onOpenFeature(f.id) : undefined}
      />
    );
  };
  if (collapsible) {
    return (
      <>
        <button className={`task-group-h tgh-btn ${collapsed ? "is-collapsed" : ""}`} onClick={onToggle} title={`${collapsed ? "Show" : "Hide"} ${label.toLowerCase()} tasks`}>
          {Icon.chevDown({ className: "tgh-chev" })}
          {label} <span className="gcount">{tasks.length}</span><span className="gline" />
        </button>
        {!collapsed && tasks.map(card)}
      </>
    );
  }
  return (
    <>
      <div className={`task-group-h ${accent ? "needs-you" : ""}`}>{label} <span className="gcount">{tasks.length}</span><span className="gline" /></div>
      {tasks.map(card)}
    </>
  );
}

// A feature's group header: chevron collapses, name opens the feature page.
// Two buttons in a div rather than one button — nesting a button inside a
// button is invalid HTML, and both affordances are wanted here (unlike the
// status groups, which have nothing to open).
function FeatureGroupHeader({ feature, collapsed, onToggle, onOpen, onSetArchived }: {
  feature: FeatureRow; collapsed: boolean; onToggle: () => void; onOpen: () => void;
  onSetArchived: (archived: number) => void;
}) {
  const pct = feature.total > 0 ? Math.round((feature.done / feature.total) * 100) : 0;
  // Whether the work actually LANDED, which the ratio alone never said: 8/8 done
  // and 8/8 done-and-merged-to-main look identical as a fraction.
  const state = featureState(feature);
  const label = FEATURE_STATE_LABEL[state];
  const stateHint =
    state === "shipped"
      ? feature.merged_at > 0
        ? `Merged into the project branch ${relTime(feature.merged_at)}`
        : "Every task is done and merged"
      : state === "in_review"
        ? "The pull request is open and waiting on your review"
        : "Every task is finished, but not everything has merged yet";
  return (
    <div className={`feat-group-h ${collapsed ? "is-collapsed" : ""}`} data-state={state} data-archived={feature.archived ? "1" : "0"} style={feature.color ? { ["--feat-accent" as string]: feature.color } : undefined}>
      <button className="fgh-chev" onClick={onToggle} title={`${collapsed ? "Show" : "Hide"} tasks in ${feature.name}`} aria-expanded={!collapsed}>
        {Icon.chevDown({ className: "tgh-chev" })}
      </button>
      <button className="fgh-name" onClick={onOpen} title={`Open ${feature.name} — context, progress and branch`}>
        {feature.key && <span className="key-chip">{feature.key}</span>}
        <span className="fgh-title">{feature.name}</span>
        {/* Dropped once it's shipped: the branch has landed, so it's the least
            interesting thing on the row — and this row is the tightest one. */}
        {feature.branch && state !== "shipped" && <span className="fgh-branch" title={`Integration branch: ${feature.branch}`}>{Icon.git()}{feature.branch}</span>}
      </button>
      {/* Only shipped / in review / done get a pill. Building and planned don't:
          the ratio and the bar already say it, and a pill on every tile is a
          pill that means nothing. */}
      {label && (
        <span className={`fgh-state s-${state}`} title={stateHint}>
          {state === "shipped" && Icon.check()}{label}
        </span>
      )}
      {/* Suggested members are counted separately: they're proposals, not
          committed work, so folding them into the denominator would report
          progress against work nobody has accepted. */}
      {feature.suggested_count > 0 && <span className="fgh-sug" title={`${feature.suggested_count} suggested, not yet accepted`}>+{feature.suggested_count}</span>}
      {feature.awaiting_count > 0 && <span className="fgh-await" title={`${feature.awaiting_count} waiting on you`}>{feature.awaiting_count}</span>}
      {/* This branch stopped being able to follow the project branch. Shown here
          because the catch-up runs after SOMEONE ELSE's merge — there is no
          session of this feature's own that would otherwise surface it. */}
      {feature.sync_conflict && (
        <span className="fgh-conflict" title={feature.sync_conflict}>{Icon.git()} conflict</span>
      )}
      <span className="fgh-count" title={`${feature.done} of ${feature.total} done`}>{feature.done}/{feature.total}</span>
      {/* Archive from here rather than only from the feature page: a finished
          feature is exactly the one you don't want to open again. */}
      <button
        className="fgh-arch"
        onClick={() => onSetArchived(feature.archived ? 0 : 1)}
        title={feature.archived ? `Bring ${feature.name} back into the working set` : `Archive ${feature.name} — its tasks stay filed under it`}
      >
        {feature.archived ? Icon.restore() : Icon.archive()}
      </button>
      <span className="fgh-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

// Per-group collapsed flag, persisted in localStorage under `key`.
function useCollapsed(key: string, def: boolean) {
  const [collapsed, setCollapsed] = useState(def);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      setCollapsed(v === null ? def : v === "1");
    } catch {}
  }, [key, def]);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(key, next ? "1" : "0"); } catch {}
    return next;
  });
  return [collapsed, toggle] as const;
}

// Tasks inside a feature group, ordered by status — the working set first, the
// graveyard last. Manual position needs no tiebreak here: listTasks already
// returns the project's tasks in position order and Array#sort is stable, so
// relative position survives within each status band.
//
// Keeping done/cancelled INSIDE their feature is the point: a shipped feature
// collapses to one line instead of spraying rows into two distant global
// buckets on the other side of the list.
const STATUS_RANK = new Map(STATUSES.map((s, i) => [s, i]));
const byStatus = (a: TaskRow, b: TaskRow) =>
  (STATUS_RANK.get(a.status) ?? 9) - (STATUS_RANK.get(b.status) ?? 9);

// One feature's section: header plus its (collapsible) tasks. Finished features
// default to collapsed — a shipped feature is history, and folding it is the
// whole reason its tasks stay filed under it instead of scattering.
function FeatureGroup({ feature, tasks, agents, selTaskId, running, blockedBy, onSelect, onOpen, onSetArchived }: {
  feature: FeatureRow; tasks: TaskRow[]; agents: AgentsBundle; selTaskId: string | null;
  running: Set<string>; blockedBy: Map<string, string[]>; onSelect: (id: string) => void; onOpen: () => void;
  onSetArchived: (archived: number) => void;
}) {
  const [collapsed, toggle] = useCollapsed(`orch_feat_collapsed_${feature.id}`, isFinished(featureState(feature)));
  return (
    <>
      <FeatureGroupHeader feature={feature} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} onSetArchived={onSetArchived} />
      {!collapsed && tasks.map((t) => (
        <TaskCard
          key={t.id} task={t} agents={agents} selected={t.id === selTaskId}
          running={running.has(t.id)} blockedBy={blockedBy.get(t.id)} onSelect={() => onSelect(t.id)}
        />
      ))}
    </>
  );
}

export function TasksColumn({ project, agents, features, tasks, suggested, selTaskId, running, blockedBy, width, loading, view, onSetView, onMoveTask, onSelectTask, onSelectFeature, onSetFeatureArchived, onNewTask, onNewFeature, onEditContext, onShowSessions, onShowRecap, onEditTask, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onCollapse, mobile, onBack }: {
  project: ProjectRow; agents: AgentsBundle; features: FeatureRow[]; tasks: TaskRow[]; suggested: TaskRow[]; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; width: number; loading?: boolean;
  view: TaskView; onSetView: (v: TaskView) => void;
  onMoveTask: (id: string, patch: Partial<Pick<TaskRow, "status" | "suggested">>, orderedIds: string[]) => void;
  onSelectTask: (id: string) => void; onSelectFeature: (id: string) => void; onSetFeatureArchived: (id: string, archived: number) => void; onNewTask: () => void; onNewFeature: () => void; onEditContext: () => void; onShowSessions: () => void; onShowRecap: () => void;
  onEditTask: (id: string) => void; onCollapse: () => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
  mobile?: boolean; onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  // Minimize the Done/Cancelled groups so a long backlog of finished (or
  // abandoned) tasks doesn't force scrolling past them. Per-project, persisted
  // so the choice sticks across reloads. Cancelled starts collapsed — it's the
  // graveyard, not the working set.
  const [doneCollapsed, toggleDone] = useCollapsed(`orch_done_collapsed_${project.id}`, false);
  const [cancelledCollapsed, toggleCancelled] = useCollapsed(`orch_cancelled_collapsed_${project.id}`, true);
  // Archived features get their own collapsed section at the bottom. Without it
  // the flag is a one-way trapdoor: archiving hid a feature from every list, and
  // no list showed archived features, so nothing could ever be restored.
  const [archivedCollapsed, toggleArchived] = useCollapsed(`orch_archived_collapsed_${project.id}`, true);
  const q = query.trim().toLowerCase();
  // Keys are matched too, so "tme-42" or just "42" jumps straight to the task —
  // which is the entire point of having an identifier worth sharing. Optional-
  // chained because a row's shape here is a JSON assertion, not a checked type:
  // a route that hands back a bare task must not crash the whole list.
  const match = (t: TaskRow) =>
    !q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q) || (t.key ?? "").toLowerCase().includes(q);
  const shown = tasks.filter(match);
  const shownSuggested = suggested.filter(match);
  const needsYou = shown.filter((t) => isAwaiting(t));
  // Feature groups take the tasks that belong to one; the status groups below
  // keep everything else. So a project with no features renders exactly as it
  // did before this layer existed — `grouped` is empty and `loose` is all of it.
  const activeFeatures = features.filter((f) => !f.archived);
  // ARCHIVED FEATURES COUNT HERE. They render in their own section further down,
  // and a task filed under one must stay filed under it — leaving them out meant
  // archiving a feature sprayed its tasks into the flat status groups, the exact
  // opposite of what grouping is for (see the note above byStatus).
  const featureIds = new Set(features.map((f) => f.id));
  // Awaiting tasks are pinned in their own group at the top and must not also
  // appear inside a feature — the status groups already exclude them the same
  // way (`!isAwaiting`), and double-rendering a task would break selection.
  const inFeature = (t: TaskRow) => !!t.feature_id && featureIds.has(t.feature_id) && !isAwaiting(t);
  const loose = shown.filter((t) => !inFeature(t));
  const byFeature = new Map<string, TaskRow[]>();
  for (const t of shown) {
    if (!inFeature(t)) continue;
    const list = byFeature.get(t.feature_id!);
    if (list) list.push(t);
    else byFeature.set(t.feature_id!, [t]);
  }
  for (const list of byFeature.values()) list.sort(byStatus);
  // A feature renders when it has matching tasks, or — absent a search — always,
  // so a freshly created (still empty) feature is visible enough to fill.
  // Finished ones sink to the bottom of the working set (sort is stable, so
  // manual position survives within each band) on their way to being archived.
  const visible = (f: FeatureRow) => (byFeature.get(f.id)?.length ?? 0) > 0 || !q;
  const shownFeatures = activeFeatures
    .filter(visible)
    .sort((a, b) => Number(isFinished(featureState(a))) - Number(isFinished(featureState(b))));
  const archivedFeatures = features.filter((f) => f.archived && visible(f));
  const groups = {
    a: loose.filter((t) => t.status === "in_progress" && !isAwaiting(t)),
    h: loose.filter((t) => t.status === "on_hold" && !isAwaiting(t)),
    r: loose.filter((t) => t.status === "not_started"),
    g: loose.filter((t) => t.status === "done").sort((a, b) => b.updated_at - a.updated_at),
    x: loose.filter((t) => t.status === "cancelled").sort((a, b) => b.updated_at - a.updated_at),
  };
  // Suggested tasks sub-grouped by feature, so an agent's twenty-task breakdown
  // arrives as one labelled block instead of twenty loose cards.
  const sugByFeature = new Map<string | null, TaskRow[]>();
  for (const s of shownSuggested) {
    const key = s.feature_id && featureIds.has(s.feature_id) ? s.feature_id : null;
    const list = sugByFeature.get(key);
    if (list) list.push(s);
    else sugByFeature.set(key, [s]);
  }
  // Across ALL features, not just active ones — a suggestion (or an awaiting
  // task) filed under an archived feature still has to render its name.
  const featureName = (id: string | null) => (id ? features.find((f) => f.id === id)?.name : undefined);
  const canSearch = tasks.length + suggested.length >= SEARCH_MIN;
  const noMatches = q && shown.length === 0 && shownSuggested.length === 0;
  return (
    <div className="col col-tasks" style={{ flexBasis: width }}>
      <div className="proj-banner">
        <div className="pb-row">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to projects" aria-label="Back to projects">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          <button className="pb-home" onClick={onShowRecap} title="Project recap / overview">
            <span className="pb-pic" style={{ background: project.color }}>{project.name[0]}</span>
            <span className="pb-name">{project.name}</span>
          </button>
          <button className="btn btn-line btn-sm" onClick={onShowSessions} title="Agent sessions run under this project">{Icon.clock()} Sessions</button>
          <button className="btn btn-line btn-sm" onClick={onNewFeature} title="Group related tasks under a feature with shared context">{Icon.plus()} Feature</button>
          <button className="btn btn-line btn-sm" onClick={onNewTask}>{Icon.plus()} Task</button>
          <div className="view-toggle" role="tablist" aria-label="Task layout">
            <button className={view === "list" ? "on" : ""} role="tab" aria-selected={view === "list"} title="List view" onClick={() => onSetView("list")}>{Icon.list()}</button>
            <button className={view === "board" ? "on" : ""} role="tab" aria-selected={view === "board"} title="Board view" onClick={() => onSetView("board")}>{Icon.board()}</button>
          </div>
          {!mobile && <button className="icon-btn" onClick={onCollapse} title="Hide tasks panel">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
        </div>
        <button className="pb-ctx" onClick={onEditContext} title="Edit project context">
          <div className={`ctx-txt ${project.context ? "" : "empty-ctx"}`}>
            {project.context || "Add project context — description, stack & conventions, prepended to every task."}
          </div>
          <div className="ctx-edit">{Icon.edit()} Context</div>
        </button>
      </div>
      {canSearch && <SearchBar value={query} onChange={setQuery} placeholder="Search tasks…" />}
      {loading ? (
        // The list in state is still the previous project's — skeleton cards
        // instead of a flash of the wrong tasks (or a false "No tasks yet").
        <div className="scroll">
          <div className="task-scroll">
            {[0, 1, 2].map((i) => <TaskCardSkeleton key={i} i={i} />)}
          </div>
        </div>
      ) : view === "board" ? (
        <div className="board-wrap">
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          <TaskBoard
            tasks={shown} suggested={shownSuggested} agents={agents} features={activeFeatures} selTaskId={selTaskId}
            running={running} blockedBy={blockedBy} canDrag={!q}
            onSelect={onSelectTask} onEditTask={onEditTask} onMove={onMoveTask}
            onStartSuggestion={onStartSuggestion} onAcceptSuggestion={onAcceptSuggestion} onDismissSuggestion={onDismissSuggestion}
          />
        </div>
      ) : (
      <div className="scroll">
        <div className="task-scroll">
          {tasks.length === 0 && <div className="empty" style={{ padding: "30px 16px" }}><div className="e-t">No tasks yet</div><div className="e-s">Create one to start an agent session.</div></div>}
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          <TaskGroup
            label="Needs your input" tasks={needsYou} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy}
            onSelect={onSelectTask} accent
            featureOf={(t) => (t.feature_id ? features.find((f) => f.id === t.feature_id) : undefined)}
            onOpenFeature={onSelectFeature}
          />
          {/* Feature groups sit above the status groups, which now hold only the
              ungrouped tasks. "Needs your input" stays pinned across all of them:
              scattering it into collapsible sections would break the one view
              that answers "what is blocking me". */}
          {shownFeatures.map((f) => (
            <FeatureGroup
              key={f.id} feature={f} tasks={byFeature.get(f.id) ?? []} agents={agents}
              selTaskId={selTaskId} running={running} blockedBy={blockedBy}
              onSelect={onSelectTask} onOpen={() => onSelectFeature(f.id)}
              onSetArchived={(archived) => onSetFeatureArchived(f.id, archived)}
            />
          ))}
          <TaskGroup label="In progress" tasks={groups.a} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="On hold" tasks={groups.h} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="Not started" tasks={groups.r} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="Done" tasks={groups.g} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} collapsible collapsed={doneCollapsed && !q} onToggle={toggleDone} />
          <TaskGroup label="Cancelled" tasks={groups.x} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} collapsible collapsed={cancelledCollapsed && !q} onToggle={toggleCancelled} />
          {/* Shipped features land here on their own (POST /features/:id/ship
              archives as it merges); everything else arrives by the Archive
              button. Each keeps its tasks, so restoring one restores the group
              exactly as it was. */}
          {archivedFeatures.length > 0 && (
            <>
              <button
                className={`task-group-h tgh-btn ${archivedCollapsed && !q ? "is-collapsed" : ""}`}
                onClick={toggleArchived}
                title={`${archivedCollapsed ? "Show" : "Hide"} archived features`}
              >
                {Icon.chevDown({ className: "tgh-chev" })}
                Archived <span className="gcount">{archivedFeatures.length}</span><span className="gline" />
              </button>
              {(!archivedCollapsed || !!q) && archivedFeatures.map((f) => (
                <FeatureGroup
                  key={f.id} feature={f} tasks={byFeature.get(f.id) ?? []} agents={agents}
                  selTaskId={selTaskId} running={running} blockedBy={blockedBy}
                  onSelect={onSelectTask} onOpen={() => onSelectFeature(f.id)}
                  onSetArchived={(archived) => onSetFeatureArchived(f.id, archived)}
                />
              ))}
            </>
          )}
        </div>
        {shownSuggested.length > 0 && (
          <div className="suggest">
            <div className="suggest-h">{Icon.spark()} Suggested by agents<span className="sp">{shownSuggested.length}</span></div>
            {/* Sub-headed by feature: a planner's breakdown arrives as one
                labelled block rather than N unrelated cards. Ungrouped
                suggestions (key null) render first, with no sub-head. */}
            {[...sugByFeature.entries()]
              .sort((a, b) => (a[0] === null ? -1 : b[0] === null ? 1 : 0))
              .map(([fid, items]) => (
              <div key={fid ?? "_none"} className="sug-feat-block">
                {fid && <div className="sug-feat-h">{featureName(fid)}<span className="sp">{items.length}</span></div>}
                {items.map((s) => (
              <div key={s.id} className="sug">
                <StatusDot status="not_started" />
                <div className="sg-meta">
                  <div className="sg-name">{s.title}</div>
                  {s.description && <div className="sg-why">{s.description}</div>}
                </div>
                <button className="sug-dismiss" title="Edit title & description" onClick={() => onEditTask(s.id)}>{Icon.edit()}</button>
                <button className="sug-add" title="Add to task list to start later" onClick={() => onAcceptSuggestion(s.id)}>{Icon.plus()} Add</button>
                <button className="sug-btn" onClick={() => onStartSuggestion(s.id)}>{Icon.play()} Start</button>
                <button className="sug-dismiss" title="Dismiss" onClick={() => onDismissSuggestion(s.id)}>{Icon.x()}</button>
              </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
