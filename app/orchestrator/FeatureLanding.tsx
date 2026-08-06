"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend, jstream } from "./api";
import { isAwaiting, relTime, featureState, fmtDur, FEATURE_STATE_LABEL } from "./format";
import { ErrNote, LoadNote, StatusDot } from "./shared";
import { clientFeatures } from "@/lib/features";
import { SLABEL, type FeatureBranchResp, type FeatureRow, type ProjectRow, type TaskRow } from "./types";

// The feature page — what fills the session column when a feature is open and
// no task is selected. Mirrors ProjectLanding's role one level down: the
// context that every member task inherits, the progress across them, and the
// integration branch (when the feature owns one).
export function FeatureLanding({ feature, project, tasks, onSelectTask, onNewTask, onSave, onArchive, onDelete, onRefresh, onBack }: {
  feature: FeatureRow;
  project: ProjectRow;
  tasks: TaskRow[]; // this feature's members, already filtered by the caller
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  onSave: (id: string, patch: Partial<Pick<FeatureRow, "name" | "description" | "context" | "archived">>) => Promise<void>;
  // Archive/restore goes through its own handler, not onSave — the server may
  // refuse (unmerged commits would strand) and the handler owns that dialog.
  onArchive: (id: string, archived: number) => void;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => void; // reload tasks+features after a git action changes them
  // Single-pane phone layout: this page replaces the task list, so it needs its
  // own way back (the same affordance SessionView and TasksColumn carry).
  onBack?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feature.name);
  const [description, setDescription] = useState(feature.description);
  const [context, setContext] = useState(feature.context);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-seed the draft when a different feature is opened (this component is
  // keyed by id at the call site, but a live rollup refresh re-renders it too).
  useEffect(() => {
    setName(feature.name);
    setDescription(feature.description);
    setContext(feature.context);
    setEditing(false);
    setConfirmDelete(false);
  }, [feature.id, feature.name, feature.description, feature.context]);

  const save = async () => {
    setSaveErr(null);
    try {
      await onSave(feature.id, { name: name.trim(), description, context });
      setEditing(false);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    }
  };

  const pct = feature.total > 0 ? Math.round((feature.done / feature.total) * 100) : 0;
  const state = featureState(feature);

  return (
    <div className="transcript">
      <div className="tw" style={{ maxWidth: 760 }}>
        <div className="feat-page">
          <div className="feat-head">
            {onBack && (
              <button className="mobile-back" onClick={onBack} title="Back to tasks" aria-label="Back to tasks">
                {Icon.chevRight({ style: { transform: "rotate(180deg)" } })}
              </button>
            )}
            <span className="feat-badge" style={feature.color ? { borderColor: feature.color, color: feature.color } : undefined}>
              {Icon.flag()} Feature
            </span>
            {feature.key && (
              <button className="key-chip key-copy" onClick={() => void navigator.clipboard?.writeText(feature.key)} title={`Copy ${feature.key}`}>
                {feature.key}
              </button>
            )}
            {editing ? (
              <input className="inp feat-name-inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Feature name" />
            ) : (
              <h2 className="feat-title">{feature.name}</h2>
            )}
            <span className="spacer" />
            {!editing && (
              <button className="btn btn-line btn-sm" onClick={() => setEditing(true)} title="Edit name, description and context">
                {Icon.edit()} Edit
              </button>
            )}
          </div>

          {editing ? (
            <input className="inp" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line — what this feature is" />
          ) : (
            feature.description && <div className="feat-desc">{feature.description}</div>
          )}

          {/* Progress. Suggested members are deliberately outside the ratio —
              they're proposals, so counting them would report progress against
              work nobody has accepted yet. */}
          <div className="feat-stats">
            <span className="feat-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
            <span className="feat-ratio">{feature.done}/{feature.total} done</span>
            {/* The same badge the tile carries, so the page and the task list
                can never disagree about whether this thing shipped. */}
            {FEATURE_STATE_LABEL[state] && (
              <span className={`fgh-state s-${state}`}>
                {state === "shipped" && Icon.check()}{FEATURE_STATE_LABEL[state]}
              </span>
            )}
            {feature.suggested_count > 0 && <span className="feat-stat sug">+{feature.suggested_count} suggested</span>}
            {feature.awaiting_count > 0 && <span className="feat-stat await">{feature.awaiting_count} waiting on you</span>}
          </div>

          <div className="feat-sect">
            <div className="feat-sect-h">
              Feature context
              <span className="feat-hint">Prepended to every task in this feature, after the project context — so it is re-sent on every turn of all {Math.max(feature.total, 1)}. Keep it spec-sized.</span>
            </div>
            {editing ? (
              <textarea
                className="inp feat-ctx-inp" value={context} onChange={(e) => setContext(e.target.value)} rows={10}
                placeholder="The shared spec: data model, constraints, decisions every task in this feature needs."
              />
            ) : feature.context ? (
              <pre className="feat-ctx">{feature.context}</pre>
            ) : (
              <div className="feat-ctx empty-ctx">No feature context yet. Add the spec once here instead of repeating it in each task&apos;s description.</div>
            )}
          </div>

          {saveErr && <ErrNote>{saveErr}</ErrNote>}

          {editing && (
            <div className="feat-actions">
              <button className="btn btn-accent btn-sm" onClick={save} disabled={!name.trim()}>{Icon.check()} Save</button>
              <button className="btn btn-line btn-sm" onClick={() => { setEditing(false); setName(feature.name); setDescription(feature.description); setContext(feature.context); setSaveErr(null); }}>Cancel</button>
            </div>
          )}

          <AutopilotPanel feature={feature} project={project} tasks={tasks} onRefresh={onRefresh} />

          <FeatureBranchPanel feature={feature} project={project} onRefresh={onRefresh} onSelectTask={onSelectTask} />

          <div className="feat-sect">
            <div className="feat-sect-h">
              Tasks <span className="gcount">{tasks.length}</span>
              <span className="spacer" />
              <button className="btn btn-line btn-sm" onClick={onNewTask}>{Icon.plus()} Task</button>
            </div>
            {tasks.length === 0 ? (
              <div className="feat-empty">No tasks yet. Create one, or ask an agent to break this feature down.</div>
            ) : (
              <div className="feat-tasks">
                {/* Each member's outcome line under its title IS the feature's
                    business summary — a rollup of stored sentences, so there's
                    no second thing to generate and nothing to keep in sync. */}
                {tasks.map((t) => (
                  <button key={t.id} className="feat-task" onClick={() => onSelectTask(t.id)}>
                    <div className="ft-row">
                      <StatusDot status={t.status} awaiting={isAwaiting(t)} />
                      {t.key && <span className="key-chip">{t.key}</span>}
                      <span className="ft-title">{t.title}</span>
                      {t.suggested === 1 && <span className="ft-sug">suggested</span>}
                      <span className="ft-status">{isAwaiting(t) ? "Needs you" : SLABEL[t.status]}</span>
                      <span className="ft-time">{relTime(t.updated_at)}</span>
                    </div>
                    {t.outcome && <div className="ft-outcome">{t.outcome}</div>}
                    {/* The escalation itself, not a link to go find it: this is
                        the one thing the user is actually being asked to act on. */}
                    {t.blocked_reason && <div className="ft-blocked">{Icon.clock()} {t.blocked_reason}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="feat-foot">
            <button
              className="btn btn-line btn-sm"
              onClick={() => onArchive(feature.id, feature.archived ? 0 : 1)}
              title={feature.archived ? "Bring this feature back into the working set" : "Hide from the task list; member tasks stay put"}
            >
              {feature.archived ? <>{Icon.restore()} Restore</> : <>{Icon.archive()} Archive</>}
            </button>
            <span className="spacer" />
            {confirmDelete ? (
              <>
                {/* The whole point of SET NULL server-side: say plainly that the
                    work survives, so "delete" doesn't read as "delete my tasks". */}
                <span className="feat-warn">
                  Delete the grouping? Its {tasks.length} task{tasks.length === 1 ? "" : "s"} stay, un-grouped.
                </span>
                <button className="btn btn-line btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="btn btn-danger btn-sm" onClick={() => void onDelete(feature.id)}>Delete</button>
              </>
            ) : (
              <button className="btn btn-line btn-sm feat-del" onClick={() => setConfirmDelete(true)}>{Icon.x()} Delete feature</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Autopilot: the two gates, and everything between them reduced to a status line.
 *
 * Off  → "Approve plan", which accepts every suggestion, cuts the integration
 *        branch if the feature hasn't got one, and starts the queue.
 * On   → what it's doing, plus Pause. Pausing stops it starting anything new;
 *        a turn already in flight is the Stop button's business, not this one's.
 * PR   → the terminal state. The remaining work is on GitHub, so the panel's
 *        job is to get out of the way and link to it.
 */
function AutopilotPanel({ feature, project, tasks, onRefresh }: {
  feature: FeatureRow;
  project: ProjectRow;
  tasks: TaskRow[];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<"" | "approve" | "pause" | "pr">("");
  const [err, setErr] = useState<string | null>(null);

  if (!clientFeatures().autopilot) return null;

  const act = async (kind: "approve" | "pause" | "pr") => {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "approve") await jsend(`/api/features/${feature.id}/approve-plan`, "POST");
      else if (kind === "pr") await jsend(`/api/features/${feature.id}/pr`, "POST");
      else await jsend(`/api/features/${feature.id}`, "PATCH", { autopilot: 0 });
      onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const blocked = tasks.filter((t) => t.blocked_reason);
  const running = tasks.filter((t) => t.running);
  const remaining = tasks.filter((t) => t.suggested === 0 && t.status !== "done" && t.status !== "cancelled");

  if (feature.pr_url) {
    return (
      <div className="feat-sect">
        <div className="feat-sect-h">Autopilot {Icon.check()} finished</div>
        <div className="feat-branch-off">
          <div className="fb-copy">
            Every task in this feature passed its gate and landed on <code>{feature.branch}</code>. The branch is pushed
            and the PR is open against <code>{project.branch}</code> — reviewing and merging it is the last step, and it&apos;s yours.
          </div>
          <a className="btn btn-accent btn-sm" href={feature.pr_url} target="_blank" rel="noreferrer">
            {Icon.git()} Review the pull request
          </a>
        </div>
      </div>
    );
  }

  if (!feature.autopilot) {
    return (
      <div className="feat-sect">
        <div className="feat-sect-h">
          Autopilot
          <span className="feat-hint">Approve the plan once; the tasks run, gate themselves, and come back as one PR.</span>
        </div>
        <div className="feat-branch-off">
          <div className="fb-copy">
            {tasks.length === 0 ? (
              // Arm-before-plan: nothing is filed yet, so say what it will do
              // when something is, rather than offering a button for 0 tasks.
              <>
                Nothing is filed here yet. Arming now means you don&apos;t have to come back and approve twice — point a
                planning task at this feature
                {!feature.branch && <> (it gets its own integration branch off <code>{project.branch}</code>)</>} and every task
                it suggests is accepted and started as it arrives, in dependency order.
              </>
            ) : (
              <>
                Approving accepts {feature.suggested_count > 0 ? `all ${feature.suggested_count} suggested task${feature.suggested_count === 1 ? "" : "s"}` : "this plan"}
                {!feature.branch && <> and gives the feature its own integration branch off <code>{project.branch}</code></>}, then
                starts working through {tasks.length} task{tasks.length === 1 ? "" : "s"} in dependency order — plus anything the
                tasks themselves suggest into this feature as they go.
              </>
            )}{" "}
            Each one has to pass the project&apos;s tests and an independent review before it merges. You&apos;ll be pulled back
            in only if something gets stuck — and again at the end, to merge the PR.
          </div>
          <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => void act("approve")}>
            {Icon.play()}{" "}
            {busy === "approve" ? "Starting…" : tasks.length === 0 ? "Arm autopilot" : "Approve plan & start"}
          </button>
        </div>
        {err && <ErrNote>{err}</ErrNote>}
      </div>
    );
  }

  return (
    <div className="feat-sect">
      <div className="feat-sect-h">
        Autopilot {Icon.bolt()} running
        <span className="spacer" />
        <button className="btn btn-line btn-sm" disabled={!!busy} onClick={() => void act("pause")} title="Stop starting new tasks. A turn already in flight keeps going — use Stop in its session to end that.">
          {busy === "pause" ? "Pausing…" : "Pause"}
        </button>
      </div>
      <div className="feat-branch">
        <div className="fb-status">
          {running.length > 0 && <span className="fb-stat ahead">{running.length} running</span>}
          <span className="fb-stat ok">{feature.done}/{feature.total} merged into {feature.branch || project.branch}</span>
          {blocked.length > 0 && <span className="fb-stat conflict">{blocked.length} stuck, waiting on you</span>}
        </div>
        {blocked.length > 0 ? (
          <div className="fb-note">
            Autopilot stopped on {blocked.length === 1 ? "a task" : `${blocked.length} tasks`} it couldn&apos;t finish. Open{" "}
            {blocked.length === 1 ? "it" : "them"} below and reply — answering clears the block and it picks the task back up.
          </div>
        ) : remaining.length === 0 ? (
          <div className="fb-note">All tasks done. Opening the pull request…</div>
        ) : null}
        <div className="fb-actions">
          <button className="btn btn-line btn-sm" disabled={!!busy || !feature.branch} onClick={() => void act("pr")} title="Push the integration branch and open the PR now, without waiting for the remaining tasks">
            {Icon.git()} {busy === "pr" ? "Opening…" : "Open the PR now"}
          </button>
        </div>
      </div>
      {err && <ErrNote>{err}</ErrNote>}
    </div>
  );
}

// The opt-in integration branch. With no branch set this is a single offer;
// with one set it's divergence from the project branch plus Sync and Ship.
function FeatureBranchPanel({ feature, project, onRefresh, onSelectTask }: { feature: FeatureRow; project: ProjectRow; onRefresh: () => void; onSelectTask: (id: string) => void }) {
  const [info, setInfo] = useState<FeatureBranchResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"" | "set" | "clear" | "sync" | "ship" | "resolve">("");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Shipping's live progress: one entry per step the route announces, gaining an
  // `ms` when it lands. Empty for every other action, which answers in one hop.
  const [steps, setSteps] = useState<{ key: string; label: string; ms?: number }[]>([]);
  const [elapsed, setElapsed] = useState(0);

  // A running clock while shipping. The per-step timings only appear once a step
  // is DONE, which leaves the longest wait of all — the feature gate running the
  // whole test suite — as the one moment with no number moving on screen.
  useEffect(() => {
    if (busy !== "ship") return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((n) => n + 1000), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setInfo(await jget<FeatureBranchResp>(`/api/features/${feature.id}/branch`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [feature.id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (kind: "set" | "clear" | "sync" | "ship", body?: unknown) => {
    setBusy(kind);
    setErr(null);
    setNote(null);
    setSteps([]);
    try {
      type ActResult = { ok?: boolean; text?: string; error?: string; conflicts?: string[] };
      let res: ActResult;
      if (kind === "ship") {
        // Ship streams its steps (see the route). Its late failures — a red gate,
        // a conflicting merge — arrive as `error` on the final line rather than
        // as a non-2xx, because the status was committed before the work began.
        res = await jstream<ActResult>(`/api/features/${feature.id}/ship`, (line) => {
          const l = line as { type?: string; key?: string; label?: string; ms?: number };
          if (l.type === "step" && l.key && l.label) {
            const { key, label } = l;
            setSteps((s) => [...s, { key, label }]);
          } else if (l.type === "step_done" && l.key) {
            const { key, ms } = l;
            setSteps((s) => s.map((x) => (x.key === key ? { ...x, ms: ms ?? 0 } : x)));
          }
        });
      } else {
        const path = kind === "sync" ? "sync" : "branch";
        const method = kind === "clear" ? "DELETE" : "POST";
        res = await jsend<ActResult>(`/api/features/${feature.id}/${path}`, method, body);
      }
      if (res.error) {
        setErr(res.error);
      } else {
        if (res.text) setNote(res.text);
        if (res.conflicts?.length) setErr(`Conflicts in ${res.conflicts.join(", ")} — resolve them in your own checkout, then sync again.`);
      }
      await load();
      onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const blocked = info?.worktreeBlockers ?? [];

  if (!feature.branch) {
    return (
      <div className="feat-sect">
        <div className="feat-sect-h">Integration branch</div>
        <div className="feat-branch-off">
          <div className="fb-copy">
            Tasks in this feature currently branch off <code>{project.branch}</code> and merge back into it, one at a time —
            exactly as tasks outside a feature do. Give the feature its own branch and they will base off and merge into
            that instead, so the whole feature lands on <code>{project.branch}</code> as one unit.
          </div>
          {blocked.length > 0 ? (
            <ErrNote>
              Can&apos;t switch now: {blocked.length} task{blocked.length === 1 ? " has" : "s have"} a live worktree cut from{" "}
              <code>{project.branch}</code> ({blocked.map((t) => t.title).join(", ")}). Merge or delete{" "}
              {blocked.length === 1 ? "it" : "them"} first — re-pointing a live worktree would silently break its diff and merge.
            </ErrNote>
          ) : (
            <button className="btn btn-accent btn-sm" disabled={busy === "set"} onClick={() => void act("set")}>
              {Icon.git()} {busy === "set" ? "Creating…" : "Use an integration branch"}
            </button>
          )}
        </div>
        {err && <ErrNote onRetry={load}>{err}</ErrNote>}
      </div>
    );
  }

  return (
    <div className="feat-sect">
      <div className="feat-sect-h">
        Integration branch
        {feature.merged_at > 0 && <span className="fb-shipped" title={`Landed on ${project.branch}`}>{Icon.check()} shipped {relTime(feature.merged_at)}</span>}
      </div>
      <div className="feat-branch">
        <div className="fb-row">
          <code className="fb-name">{Icon.git()} {feature.branch}</code>
          <span className="fb-arrow">→</span>
          <code className="fb-name">{project.branch}</code>
        </div>
        {/* Parked by the automatic catch-up that runs whenever anything lands on
            the project branch. Stated in full here (the tile only has room for a
            chip) because this page is where the resolution starts: one click
            files a member task cut from this branch, briefed on the conflict —
            reviewed and merged like any other work. */}
        {feature.sync_conflict && (
          <div className="fb-note fb-conflict">
            {Icon.git()} {feature.sync_conflict}
            {/* Only for a LIVE feature. On a shipped one this note means
                post-ship commits stranded on the branch — the remedy is the
                Ship button right below, and the note says so itself. */}
            {feature.merged_at === 0 && (
            <div className="fb-actions" style={{ marginTop: 6 }}>
              <button
                className="btn btn-accent btn-sm"
                disabled={!!busy}
                title="Start a task on this branch that merges the base in and resolves every conflict — you review its diff before it lands"
                onClick={async () => {
                  setBusy("resolve");
                  setErr(null);
                  try {
                    const res = await jsend<{ ok: boolean; taskId: string | null; text?: string }>(`/api/features/${feature.id}/resolve`, "POST");
                    if (res.text) setNote(res.text);
                    await load();
                    onRefresh();
                    if (res.taskId) onSelectTask(res.taskId);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {Icon.spark()} {busy === "resolve" ? "Starting…" : "Resolve with AI"}
              </button>
            </div>
            )}
          </div>
        )}
        {loading && !info ? (
          <LoadNote>Checking divergence…</LoadNote>
        ) : info ? (
          <div className="fb-status">
            {info.behind ? <span className="fb-stat behind">{info.behind} behind {project.branch}</span> : <span className="fb-stat ok">up to date with {project.branch}</span>}
            {!!info.ahead && <span className="fb-stat ahead">{info.ahead} ahead</span>}
            {info.conflicts?.length ? <span className="fb-stat conflict">would conflict: {info.conflicts.join(", ")}</span> : null}
          </div>
        ) : null}
        <div className="fb-actions">
          <button className="btn btn-line btn-sm" disabled={!!busy || !info?.behind} onClick={() => void act("sync")} title={info?.behind ? `Merge ${project.branch} into ${feature.branch}` : "Already up to date"}>
            {Icon.restore()} {busy === "sync" ? "Syncing…" : "Sync"}
          </button>
          <button className="btn btn-accent btn-sm" disabled={!!busy || !info?.ahead} onClick={() => void act("ship")} title={`Merge ${feature.branch} into ${project.branch}`}>
            {Icon.check()} {busy === "ship" ? "Shipping…" : "Ship feature"}
          </button>
          <span className="spacer" />
          {blocked.length === 0 && (
            <button className="btn btn-line btn-sm" disabled={!!busy} onClick={() => void act("clear")} title={`Stop using an integration branch; new tasks go back to ${project.branch}. The branch itself is left in the repo.`}>
              Stop using it
            </button>
          )}
        </div>
        {/* Shipping's live progress. Only while it runs: once it's done the
            result note below says what landed, and a finished checklist would
            just compete with it. */}
        {busy === "ship" && (
          <div className="fb-ship">
            <div className="fb-ship-h">
              <span className="spinner" />
              We&apos;re working on shipping this…
              <span className="fb-ship-el">{fmtDur(elapsed)}</span>
            </div>
            <div className="tpeek-todos">
              {steps.map((s) => (
                <div key={s.key} className={`tdo ${s.ms === undefined ? "in_progress" : "completed"}`}>
                  <span className="tdo-box">{s.ms === undefined ? "▣" : "✔"}</span>
                  <span className="tdo-txt">{s.label}</span>
                  {s.ms !== undefined && <span className="fb-ship-ms">{fmtDur(s.ms)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Advisory, not a lock — the user may know these are abandoned. */}
        {info && info.unfinished.length > 0 && (
          <div className="fb-note">
            {info.unfinished.length} task{info.unfinished.length === 1 ? "" : "s"} not finished yet
            ({info.unfinished.slice(0, 3).map((t) => t.title).join(", ")}{info.unfinished.length > 3 ? "…" : ""}).
            Shipping now lands only what has already merged into {feature.branch}.
          </div>
        )}
        {blocked.length > 0 && (
          <div className="fb-note">
            {blocked.length} task{blocked.length === 1 ? " has a live worktree" : "s have live worktrees"} on this branch, so it can&apos;t be changed until they&apos;re merged or deleted.
          </div>
        )}
        {note && <div className="fb-ok">{Icon.check()} {note}</div>}
        {err && <ErrNote onRetry={load}>{err}</ErrNote>}
      </div>
    </div>
  );
}
