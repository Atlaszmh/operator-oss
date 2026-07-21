"use client";

import { useState } from "react";
import type { Status } from "@/lib/types";
import { Icon } from "../icons";
import { isAwaiting, relTime } from "./format";
import { AWAIT_LABEL, type TaskRow, type AgentsBundle } from "./types";
import { agentLabel } from "./agents";
import { StatusDot, PriPill, AgentBadge } from "./shared";

// The kanban alternative to the grouped task list. Columns are live views over
// the same task rows the list renders (so cards update as sessions stream), and
// dragging a card re-statuses it and/or persists a new manual order.
type ColKey = "suggested" | "not_started" | "in_progress" | "awaiting" | "on_hold" | "done" | "cancelled";

const COL_ORDER: ColKey[] = ["suggested", "not_started", "in_progress", "awaiting", "on_hold", "done", "cancelled"];

// What lands on a task dropped into each column. `null` = the column rejects
// the drop (Suggested and Needs-input hold derived states you can't drag INTO —
// they still allow reordering their own cards). `{}` = position-only move.
type Patch = Partial<Pick<TaskRow, "status" | "suggested">> | null;

const COLS: Record<ColKey, { label: string; accent?: boolean; always: boolean; member: (t: TaskRow) => boolean; patchFor: (t: TaskRow) => Patch }> = {
  suggested: {
    label: "Suggested", always: true,
    member: (t) => !!t.suggested,
    patchFor: (t) => (t.suggested ? {} : null),
  },
  not_started: {
    label: "Not started", always: true,
    member: (t) => !t.suggested && t.status === "not_started",
    patchFor: (t) => statusPatch(t, "not_started"),
  },
  in_progress: {
    label: "In progress", always: true,
    member: (t) => !t.suggested && t.status === "in_progress" && !isAwaiting(t),
    // Dropping an awaiting card here is "I've dealt with it": the explicit
    // status write clears the awaiting flag server-side, so patch even when
    // the status string wouldn't change.
    patchFor: (t) => (t.suggested ? { suggested: 0, status: "in_progress" } : t.status !== "in_progress" || isAwaiting(t) ? { status: "in_progress" } : {}),
  },
  awaiting: {
    label: "Needs input", accent: true, always: true,
    member: (t) => !t.suggested && isAwaiting(t),
    patchFor: (t) => (!t.suggested && isAwaiting(t) ? {} : null),
  },
  on_hold: {
    label: "On hold", always: false,
    member: (t) => !t.suggested && t.status === "on_hold",
    patchFor: (t) => statusPatch(t, "on_hold"),
  },
  done: {
    label: "Done", always: true,
    member: (t) => !t.suggested && t.status === "done",
    patchFor: (t) => statusPatch(t, "done"),
  },
  cancelled: {
    label: "Cancelled", always: false,
    member: (t) => !t.suggested && t.status === "cancelled",
    patchFor: (t) => statusPatch(t, "cancelled"),
  },
};

// Dropping into a plain status column: accept a suggestion into the real list,
// change status when it differs, or (same column) just reorder.
function statusPatch(t: TaskRow, status: Status): Patch {
  if (t.suggested) return { suggested: 0, status };
  return t.status !== status ? { status } : {};
}

function BoardCard({ task, agents, selected, running, blocked, dropBefore, dragging, canDrag, onSelect, onDragStart, onDragOverCard, onDropOnCard, onDragEnd, actions }: {
  task: TaskRow; agents: AgentsBundle; selected: boolean; running: boolean; blocked: boolean;
  dropBefore: boolean; dragging: boolean; canDrag: boolean;
  onSelect: () => void; onDragStart: () => void; onDragOverCard: (e: React.DragEvent) => void;
  onDropOnCard: (e: React.DragEvent) => void; onDragEnd: () => void; actions?: React.ReactNode;
}) {
  const awaiting = isAwaiting(task);
  const activity = awaiting ? AWAIT_LABEL.toLowerCase()
    : running ? "live · working"
    : task.started ? relTime(task.updated_at) : "not started";
  return (
    <div
      role="button" tabIndex={0}
      className={`task bcard ${selected ? "sel" : ""} ${awaiting ? "awaiting" : ""} ${dragging ? "dragging" : ""} ${dropBefore ? "drop-before" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      draggable={canDrag}
      onDragStart={(e) => { onDragStart(); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={onDragOverCard}
      onDrop={onDropOnCard}
      onDragEnd={onDragEnd}
      title={canDrag ? "Drag to move / reorder" : undefined}
    >
      <div className="task-top">
        <StatusDot status={task.status} running={running} awaiting={awaiting} />
        <span className="ttitle">{task.title}</span>
        <PriPill p={task.priority} />
      </div>
      <div className="task-foot">
        <span className="activity">
          {awaiting ? <span style={{ color: "var(--blue)" }}>●</span> : running ? <span style={{ color: "var(--amber)" }}>●</span> : null}
          {activity}
          {blocked && <span title="Blocked by another task">{Icon.lock()}</span>}
        </span>
        <span className="spacer" />
        <AgentBadge label={agentLabel(agents, task.agent)} multi={agents.agents.length > 1} />
        {actions}
      </div>
    </div>
  );
}

export function TaskBoard({ tasks, suggested, agents, selTaskId, running, blockedBy, canDrag, onSelect, onEditTask, onMove, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion }: {
  tasks: TaskRow[]; suggested: TaskRow[]; agents: AgentsBundle; selTaskId: string | null;
  running: Set<string>; blockedBy: Map<string, string[]>;
  // Dragging is disabled while a search filter is active: hidden cards would be
  // silently dropped from the persisted order.
  canDrag: boolean;
  onSelect: (id: string) => void; onEditTask: (id: string) => void;
  onMove: (id: string, patch: Partial<Pick<TaskRow, "status" | "suggested">>, orderedIds: string[]) => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: ColKey; index: number } | null>(null);
  const all = [...suggested, ...tasks];
  const dragTask = dragId ? all.find((x) => x.id === dragId) : undefined;
  const cols = new Map<ColKey, TaskRow[]>(COL_ORDER.map((k) => [k, all.filter(COLS[k].member)]));
  const reset = () => { setDragId(null); setOver(null); };

  const drop = (colKey: ColKey, index: number) => {
    const t = dragId ? all.find((x) => x.id === dragId) : undefined;
    reset();
    if (!t) return;
    const patch = COLS[colKey].patchFor(t);
    if (patch === null) return; // column rejects this card
    // Rebuild every column's id list with the card removed, insert it at the
    // drop index (computed against the pre-removal list, so dragging downward
    // lands after the hovered card — same feel as the projects sidebar), then
    // flatten in column order into the project's new manual order.
    const lists = new Map<ColKey, string[]>(
      COL_ORDER.map((k) => [k, cols.get(k)!.map((x) => x.id).filter((id) => id !== t.id)])
    );
    const destination = lists.get(colKey)!;
    destination.splice(Math.min(index, destination.length), 0, t.id);
    const orderedIds = COL_ORDER.flatMap((k) => lists.get(k)!);
    onMove(t.id, patch, orderedIds);
  };

  return (
    <div className="board">
      {COL_ORDER.map((key) => {
        const def = COLS[key];
        const colTasks = cols.get(key)!;
        // On hold / Cancelled aren't part of the core flow: they only appear
        // when something is actually in them, so those statuses are never
        // invisible but the default board stays five columns.
        if (!def.always && colTasks.length === 0) return null;
        const isOver = !!dragTask && over?.col === key && def.patchFor(dragTask) !== null;
        return (
          <div
            key={key}
            className={`bcol ${isOver ? "drag-over" : ""} ${def.accent ? "needs-you" : ""}`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId) setOver({ col: key, index: colTasks.length }); }}
            onDrop={(e) => { e.preventDefault(); drop(key, colTasks.length); }}
          >
            <div className={`task-group-h ${def.accent ? "needs-you" : ""}`}>
              {def.label} <span className="gcount">{colTasks.length}</span><span className="gline" />
            </div>
            <div className="bcol-body">
              {colTasks.map((t, i) => (
                <BoardCard
                  key={t.id}
                  task={t}
                  agents={agents}
                  selected={t.id === selTaskId}
                  running={running.has(t.id)}
                  blocked={!!blockedBy.get(t.id)?.length && !t.started}
                  dragging={dragId === t.id}
                  dropBefore={isOver && over?.index === i}
                  canDrag={canDrag}
                  onSelect={() => (t.suggested ? onEditTask(t.id) : onSelect(t.id))}
                  onDragStart={() => setDragId(t.id)}
                  onDragOverCard={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; if (dragId) setOver({ col: key, index: i }); }}
                  onDropOnCard={(e) => { e.preventDefault(); e.stopPropagation(); drop(key, i); }}
                  onDragEnd={reset}
                  actions={t.suggested ? (
                    <span className="bcard-acts" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Start now" onClick={() => onStartSuggestion(t.id)}>{Icon.play()}</button>
                      <button className="icon-btn" title="Add to task list to start later" onClick={() => onAcceptSuggestion(t.id)}>{Icon.plus()}</button>
                      <button className="icon-btn" title="Dismiss" onClick={() => onDismissSuggestion(t.id)}>{Icon.x()}</button>
                    </span>
                  ) : undefined}
                />
              ))}
              {colTasks.length === 0 && <div className="bcol-empty">{dragId ? "Drop here" : "Empty"}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
