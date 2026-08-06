"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Priority } from "@/lib/types";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { relTime, duration } from "./format";
import { SLABEL, modelOptions, reasoningOptions, type FeatureRow, type ProjectRow, type ProjectSession, type TaskRow, type AgentsBundle, type PickerOption } from "./types";
import { agentLabel, capsFor, defaultAgentFor, findAgent } from "./agents";
import { StatusDot, Skel, ErrNote } from "./shared";
import { Modal, BrowseDirButton, PrioritySeg, DepPicker } from "./Modal";
import { GitHubClonePicker } from "./github";
import { Markdown } from "../Markdown";
import { clientFeatures } from "@/lib/features";
import { validateKey } from "@/lib/keys";

// Segmented agent picker (Claude Code / Codex …). Hidden when only one agent is
// registered — nothing to choose. An unauthenticated agent is still selectable
// (you can create a not-started task and connect later) but flagged, with a
// Connect CTA that jumps to the setup wizard.
export function AgentPicker({ agents, value, onChange, onConnect, help, label = "Agent" }: {
  agents: AgentsBundle; value: string; onChange: (id: string) => void; onConnect?: () => void; help?: string; label?: string;
}) {
  if (agents.agents.length <= 1) return null;
  const sel = findAgent(agents, value);
  return (
    <div className="field">
      <div className="lab">{label}</div>
      <div className="seg" style={{ flexWrap: "wrap" }}>
        {agents.agents.map((a) => (
          <button key={a.id} className={a.id === value ? "on" : ""} onClick={() => onChange(a.id)}
            title={a.authenticated ? `Run on ${a.label}` : `${a.label} isn't connected yet`}>
            {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
          </button>
        ))}
      </div>
      {sel && !sel.authenticated ? (
        <div className="hlp" style={{ color: "var(--amber)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{sel.label} isn’t connected — connect it before starting a session.</span>
          {onConnect && <button className="btn btn-line btn-sm" onClick={onConnect}>Connect {sel.label}</button>}
        </div>
      ) : (
        <div className="hlp">{help ?? "Fixed once the task is created — a session can’t move between CLIs."}</div>
      )}
    </div>
  );
}

// Model / reasoning picker for the task modals. A native <select> rather than
// SessionView's Popover: the Claude list runs to fourteen options across three
// groups, and the native control brings keyboard navigation, type-ahead, scroll
// containment and screen-reader semantics with no code to maintain. `value:
// null` is the synthetic "Default" head — inherit the agent's default.
export function RunSelect({ label, options, value, onChange }: {
  label: string; options: PickerOption[]; value: string | null; onChange: (v: string | null) => void;
}) {
  // Consecutive options sharing a group render under one <optgroup>, mirroring
  // how the session toolbar sections the same list.
  const groups: { group?: string; opts: PickerOption[] }[] = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last && last.group === o.group) last.opts.push(o);
    else groups.push({ group: o.group, opts: [o] });
  }
  const sel = options.find((o) => o.value === value);
  return (
    <div className="field">
      <div className="lab">{label}</div>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        {groups.map((g, i) => (
          <Fragment key={i}>
            {g.group ? (
              <optgroup label={g.group}>
                {g.opts.map((o) => <option key={o.label} value={o.value ?? ""}>{o.label}</option>)}
              </optgroup>
            ) : (
              g.opts.map((o) => <option key={o.label} value={o.value ?? ""}>{o.label}</option>)
            )}
          </Fragment>
        ))}
      </select>
      {sel?.sub && <div className="hlp">{sel.sub}</div>}
    </div>
  );
}

// Which feature (if any) a task belongs to. Rendered only when the project has
// features — the layer is optional, so a project that doesn't use it never sees
// a picker for it. Archived features are excluded, except the one already
// assigned, so re-opening a task filed under an archived feature doesn't
// silently move it.
export function FeaturePicker({ features, value, onChange }: {
  features: FeatureRow[]; value: string | null; onChange: (v: string | null) => void;
}) {
  const options = features.filter((f) => !f.archived || f.id === value);
  if (options.length === 0) return null;
  const sel = options.find((f) => f.id === value);
  return (
    <div className="field">
      <div className="lab">Feature <span className="opt">— optional grouping</span></div>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No feature</option>
        {options.map((f) => <option key={f.id} value={f.id}>{f.name}{f.archived ? " (archived)" : ""}</option>)}
      </select>
      <div className="hlp">
        {sel?.context
          ? `"${sel.name}" context is prepended to this task's prompt, after the project context.`
          : sel
            ? `Groups with "${sel.name}". It has no feature context yet.`
            : "Group related tasks so they share context and can ship together."}
      </div>
    </div>
  );
}

export function NewTaskModal({ project, agents, features, defaultFeature, tasks, onClose, onCreate, onOpenSetup }: { project: ProjectRow; agents: AgentsBundle; features: FeatureRow[]; defaultFeature?: string | null; tasks: TaskRow[]; onClose: () => void; onCreate: (i: { title: string; desc: string; priority: Priority; agent: string; model: string | null; reasoning: string | null; feature_id: string | null; startNow: boolean; depends_on: string[] }) => void; onOpenSetup?: () => void }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState<Priority>("med");
  const [agent, setAgent] = useState(() => defaultAgentFor(agents, project.default_agent));
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [startNow, setStartNow] = useState(false);
  const [deps, setDeps] = useState<string[]>([]);
  // Pre-filled when the modal is opened FROM a feature page, so "+ Task" there
  // files into that feature instead of making you pick it again.
  const [featureId, setFeatureId] = useState<string | null>(defaultFeature ?? null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // The bundle can arrive after mount; adopt the resolved default until the user picks.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setAgent(defaultAgentFor(agents, project.default_agent)); }, [agents, project.default_agent]);
  // The run options come from the selected agent's descriptor, so a Claude model
  // value means nothing after a switch to Codex — reset both.
  const pickAgent = (id: string) => { touched.current = true; setAgent(id); setModel(null); setReasoning(null); };
  const caps = capsFor(agents, agent);
  const can = title.trim().length > 0;
  // A task with unfinished blockers can't start now, so the two options are exclusive.
  const blocked = deps.some((id) => tasks.find((t) => t.id === id)?.status !== "done");
  // Can't launch a session on an agent that isn't signed in — but the task can
  // still be created (not started) and started once the agent is connected.
  const selAgent = findAgent(agents, agent);
  const agentReady = selAgent ? selAgent.authenticated : true;
  const canStart = !blocked && agentReady;
  const create = () => can && onCreate({ title: title.trim(), desc: desc.trim(), priority, agent, model, reasoning, feature_id: featureId, startNow: startNow && canStart, depends_on: deps });
  return (
    <Modal title="New task" sub={`${project.name} · title + description become ${agentLabel(agents, agent)}'s first prompt`} onClose={onClose}
      footer={<>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: !canStart ? "var(--ink-4)" : "var(--ink-2)", cursor: !canStart ? "not-allowed" : "pointer" }}
          title={blocked ? "Can't start now — this task is blocked by unfinished tasks" : !agentReady ? `Connect ${selAgent?.label} to start a session` : undefined}>
          <input type="checkbox" checked={startNow && canStart} disabled={!canStart} onChange={(e) => setStartNow(e.target.checked)} /> Start session immediately
        </label>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!can} onClick={create}>{Icon.plus()} Create task</button>
      </>}>
      <div className="field">
        <div className="lab">Title</div>
        <input ref={ref} type="text" value={title} placeholder="e.g. Add rate-limiting to auth endpoints"
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && can) create(); }} />
      </div>
      <div className="field">
        <div className="lab">Description <span className="opt">— what to do</span></div>
        <textarea value={desc} placeholder="Describe the feature or task. This is the body of the prompt the agent starts with." onChange={(e) => setDesc(e.target.value)} />
        <div className="hlp">Project context is prepended automatically — no need to restate the stack or conventions.</div>
      </div>
      <FeaturePicker features={features} value={featureId} onChange={setFeatureId} />
      <AgentPicker agents={agents} value={agent} onChange={pickAgent} onConnect={onOpenSetup} />
      <RunSelect label="Model" options={modelOptions(caps)} value={model} onChange={setModel} />
      <RunSelect label="Reasoning" options={reasoningOptions(caps)} value={reasoning} onChange={setReasoning} />
      <div className="field">
        <div className="lab">Priority</div>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      <DepPicker candidates={tasks} value={deps} onChange={setDeps} />
    </Modal>
  );
}

export function EditTaskModal({ task, tasks, agents, features, onClose, onSave, onDelete }: {
  task: TaskRow; tasks: TaskRow[]; agents: AgentsBundle; features: FeatureRow[]; onClose: () => void;
  onSave: (id: string, patch: { title: string; description: string; priority: Priority; model: string | null; reasoning: string | null; feature_id: string | null; depends_on: string[] }) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [featureId, setFeatureId] = useState<string | null>(task.feature_id);
  const [deps, setDeps] = useState<string[]>(task.depends_on ?? []);
  const [model, setModel] = useState<string | null>(task.model);
  const [reasoning, setReasoning] = useState<string | null>(task.reasoning);
  // A task's agent is fixed at creation, so the options never change under us.
  const caps = capsFor(agents, task.agent);
  const [confirmDel, setConfirmDel] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const can = title.trim().length > 0;
  const candidates = useMemo(() => tasks.filter((t) => t.id !== task.id), [tasks, task.id]);
  const save = () => can && onSave(task.id, { title: title.trim(), description: desc.trim(), priority, model, reasoning, feature_id: featureId, depends_on: deps });
  return (
    <Modal title="Edit task" sub="title + description become the agent's first prompt" onClose={onClose}
      footer={<>
        {confirmDel ? (
          <button className="btn-danger on" onClick={() => onDelete(task.id)} title="Permanently remove this task, its session and worktree">{Icon.x()} Delete task permanently</button>
        ) : (
          <button className="btn-danger" onClick={() => setConfirmDel(true)}>{Icon.x()} Delete task</button>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!can} onClick={save}>{Icon.check()} Save changes</button>
      </>}>
      <div className="field">
        <div className="lab">Title</div>
        <input ref={ref} type="text" value={title} placeholder="e.g. Add rate-limiting to auth endpoints"
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && can) save(); }} />
      </div>
      <div className="field">
        <div className="lab">Description <span className="opt">— what to do</span></div>
        <textarea value={desc} placeholder="Describe the feature or task. This is the body of the prompt the agent starts with." onChange={(e) => setDesc(e.target.value)} />
        <div className="hlp">Project context is prepended automatically — no need to restate the stack or conventions.</div>
      </div>
      <div className="field">
        <div className="lab">Priority</div>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      <FeaturePicker features={features} value={featureId} onChange={setFeatureId} />
      <RunSelect label="Model" options={modelOptions(caps)} value={model} onChange={setModel} />
      <RunSelect label="Reasoning" options={reasoningOptions(caps)} value={reasoning} onChange={setReasoning} />
      <DepPicker candidates={candidates} value={deps} onChange={setDeps} />
      {confirmDel && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 16 }}>
          This permanently removes “{task.title}”, its agent session and git worktree from the orchestrator. Any unmerged work in the worktree is discarded.
        </div>
      )}
    </Modal>
  );
}

export function NewFeatureModal({ project, onClose, onCreate }: {
  project: ProjectRow; onClose: () => void;
  onCreate: (i: { name: string; description: string; context: string }) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const can = name.trim().length > 0 && !busy;
  const create = async () => {
    if (!can) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate({ name: name.trim(), description: description.trim(), context: context.trim() });
    } catch (e) {
      // The likely failure is a 409 on the project-unique name — show it here
      // rather than closing over a silent no-op.
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="New feature" sub={`${project.name} · groups related tasks and shares context between them`} onClose={onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!can} onClick={create}>{Icon.plus()} Create feature</button>
      </>}>
      <div className="field">
        <div className="lab">Name</div>
        <input ref={ref} type="text" value={name} placeholder="e.g. Billing v2"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && can) void create(); }} />
        <div className="hlp">Unique within this project. Agents can file tasks into it by this name.</div>
      </div>
      <div className="field">
        <div className="lab">Description <span className="opt">— one line</span></div>
        <input type="text" value={description} placeholder="e.g. Move subscriptions from Paddle to Stripe" onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <div className="lab">Feature context <span className="opt">— optional, shared by every task here</span></div>
        <textarea value={context} placeholder="The shared spec: data model, constraints, decisions every task in this feature needs." onChange={(e) => setContext(e.target.value)} />
        <div className="hlp">Prepended to each member task&apos;s prompt after the project context — so write it once here instead of in every description. It is re-sent on every turn, so keep it spec-sized.</div>
      </div>
      {err && <ErrNote>{err}</ErrNote>}
    </Modal>
  );
}

// Mirror of the server's RefreshState (lib/contextRefresh.ts) — the detached
// "Refresh with AI" job state the modal polls.
type RefreshState = { status: "idle" | "running" | "done" | "error"; draft: string; error: string; started_at: number };

export function ContextModal({ project, agents, onSetDefaultAgent, onClose, onSave, onDelete, onDeprecate }: { project: ProjectRow; agents: AgentsBundle; onSetDefaultAgent: (agent: string) => void; onClose: () => void; onSave: (p: { name: string; key: string; context: string; repo_path: string; branch: string; dev_command: string; setup_command: string; test_command: string }) => void | Promise<void>; onDelete: () => void; onDeprecate: () => void }) {
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key);
  // Same validator the PATCH route runs, so Save is disabled rather than
  // round-tripping to a 400 the user has to read out of a toast. Uniqueness is
  // the server's call (only it sees every project), so that one comes back as a
  // 409 and is shown here — a taken key is the likely failure, not an exotic one.
  const keyErr = validateKey(key);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [context, setContext] = useState(project.context);
  const [repo, setRepo] = useState(project.repo_path);
  const [branch, setBranch] = useState(project.branch);
  const [devCmd, setDevCmd] = useState(project.dev_command);
  const [setupCmd, setSetupCmd] = useState(project.setup_command);
  const [testCmd, setTestCmd] = useState(project.test_command);
  const [confirmDel, setConfirmDel] = useState(false);
  const showServices = clientFeatures().services;
  // AI context refresh: let Claude read the repo and draft fresh context. The
  // draft now runs as a DETACHED server-side job (it can take minutes and must
  // survive sleep/reload), so the client starts it and polls for the result
  // rather than holding one long request open. The drafted text replaces the
  // textarea but isn't saved until Save — we stash the prior text for Undo.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [prevContext, setPrevContext] = useState<string | null>(null);
  // Edit vs. rendered-markdown preview of the context. Refreshing forces edit
  // (the textarea shows the disabled/loading state).
  const [preview, setPreview] = useState(false);
  const showPreview = preview && !refreshing;

  // Latest edited context, read inside async handlers without making them
  // depend on `context` (which would churn the polling effect / stale-close it).
  const contextRef = useRef(context);
  contextRef.current = context;
  // started_at of the job whose result we've already applied — so a draft is
  // consumed exactly once even if a POST reply and a poll tick race.
  const appliedRef = useRef(0);

  const ackRefresh = useCallback(() => {
    jsend(`/api/projects/${project.id}/refresh-context`, "DELETE").catch(() => {});
  }, [project.id]);

  // Fold a polled job state into the UI. Idempotent: applies a finished draft at
  // most once, then acks it so it doesn't resurface on the next modal open.
  const handleState = useCallback((s: RefreshState) => {
    if (s.status === "running") { setRefreshing(true); return; }
    if (s.started_at && appliedRef.current !== s.started_at) {
      if (s.status === "done" && s.draft) {
        appliedRef.current = s.started_at;
        setPrevContext(contextRef.current);
        setContext(s.draft);
        setRefreshErr(null);
        ackRefresh();
      } else if (s.status === "error") {
        appliedRef.current = s.started_at;
        setRefreshErr(s.error || "refresh failed");
        ackRefresh();
      }
    }
    setRefreshing(false);
  }, [ackRefresh]);

  // On open, reconnect to whatever the server has: a still-running job, or a
  // draft/error left from a job that finished while the modal was closed.
  useEffect(() => {
    let alive = true;
    jget<RefreshState>(`/api/projects/${project.id}/refresh-context`)
      .then((s) => { if (alive) handleState(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [project.id, handleState]);

  // While a job runs, poll for its result. Stops when refreshing flips false
  // (terminal state) or the modal unmounts — the job keeps running server-side.
  useEffect(() => {
    if (!refreshing) return;
    const t = setInterval(() => {
      jget<RefreshState>(`/api/projects/${project.id}/refresh-context`).then(handleState).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [refreshing, project.id, handleState]);

  const refreshContext = async () => {
    if (refreshing) return;
    setRefreshErr(null);
    setRefreshing(true);
    try {
      handleState(await jsend<RefreshState>(`/api/projects/${project.id}/refresh-context`, "POST"));
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try { const j = JSON.parse(msg); if (j?.error) msg = j.error; } catch { /* not JSON — show raw */ }
      setRefreshErr(msg);
      setRefreshing(false);
    }
  };

  return (
    <Modal title="Project context" sub={`prepended to every task in ${project.name}`} onClose={onClose} width={620}
      footer={<>
        {confirmDel ? (
          <button className="btn-danger on" onClick={onDelete} title="Permanently remove this project, its tasks and chat history">{Icon.x()} Delete {project.name} permanently</button>
        ) : (
          <>
            <button className="btn-danger" onClick={() => setConfirmDel(true)}>{Icon.x()} Delete project</button>
            <button className="btn btn-line" onClick={onDeprecate} title="Hide this project under the sidebar's deprecated area. Nothing is deleted — restore it any time.">{Icon.archive()} Deprecate</button>
          </>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-accent"
          disabled={!!keyErr}
          onClick={async () => {
            setSaveErr(null);
            try {
              await onSave({ name, key, context, repo_path: repo, branch, dev_command: devCmd, setup_command: setupCmd, test_command: testCmd });
            } catch (e) {
              setSaveErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >{Icon.check()} Save</button>
      </>}>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: 1 }}>
          <div className="lab">Project name</div>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ flex: "0 0 150px" }}>
          <div className="lab">Key <span className="opt">— {key || project.key}-F1, -T2, …</span></div>
          <input type="text" className="ctx-mono" value={key} maxLength={10} onChange={(e) => setKey(e.target.value.toUpperCase())} />
        </div>
      </div>
      {/* Say plainly what a rename does. The key is derived, not stored per row,
          so changing it re-points every task and feature at once — which is the
          intended behaviour, but it will strand a key someone already pasted
          into a commit message. */}
      <div className="hlp" style={{ marginTop: -8, marginBottom: 14 }}>
        {keyErr ? <span style={{ color: "var(--red)" }}>{keyErr}</span>
          : `Every task and feature in this project is identified by this prefix. Changing it renames all of them.`}
      </div>
      {saveErr && <ErrNote style={{ marginBottom: 14 }}>{saveErr}</ErrNote>}
      <div className="field">
        <div className="lab ctx-lab">
          <span>What we&apos;re building</span>
          <div className="ctx-actions">
            {prevContext != null && !refreshing && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { setContext(prevContext); setPrevContext(null); }}
                title="Restore the context from before the AI refresh"
              >Undo</button>
            )}
            <button
              className={`btn btn-line btn-sm${showPreview ? " on" : ""}`}
              onClick={() => setPreview((p) => !p)}
              disabled={refreshing}
              title="Toggle a rendered-markdown preview"
            >{Icon.doc()} {showPreview ? "Edit" : "Preview"}</button>
            <button
              className="btn btn-line btn-sm"
              onClick={refreshContext}
              disabled={refreshing || !repo}
              title={repo ? "Let an agent read the repo and draft fresh context. Review and edit before saving." : "Set a working directory first"}
            >{Icon.spark()} {refreshing ? "Reading the repo…" : "Refresh with AI"}</button>
          </div>
        </div>
        {showPreview ? (
          <div className={`md-preview${context.trim() ? "" : " empty"}`} style={{ minHeight: 150, maxHeight: 320 }}>
            {context.trim() ? <Markdown>{context}</Markdown> : "Nothing to preview yet."}
          </div>
        ) : (
          <textarea style={{ minHeight: 150 }} value={context} disabled={refreshing} onChange={(e) => setContext(e.target.value)} />
        )}
        {refreshErr ? (
          <ErrNote style={{ marginTop: 7 }} onRetry={refreshContext} retryLabel="Try again">{refreshErr}</ErrNote>
        ) : refreshing ? (
          <div className="hlp" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="typing"><i /><i /><i /></span>
            Exploring {repo.split("/").pop() || "the repo"} to draft fresh context — this can take a minute.
          </div>
        ) : prevContext != null ? (
          <div className="hlp">Drafted from the repo. Review and edit it, then Save — or Undo to revert.</div>
        ) : (
          <div className="hlp">Be specific about stack, conventions, and constraints. Every task in this project inherits it.</div>
        )}
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <div className="lab">{Icon.folder()} Working dir <span className="opt">— required to run tasks</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={repo} placeholder="/Users/you/code/project" onChange={(e) => setRepo(e.target.value)} />
            <BrowseDirButton initial={repo} onPick={setRepo} />
          </div>
        </div>
        <div className="field" style={{ flex: "0 0 170px", marginBottom: 0 }}>
          <div className="lab">{Icon.git()} Branch</div>
          <input type="text" className="ctx-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <AgentPicker
          agents={agents} value={project.default_agent} onChange={onSetDefaultAgent}
          label="Default agent for new tasks"
          help="New tasks in this project default to this agent. Existing tasks keep the agent they were created with."
        />
      </div>
      {showServices && (
        <div className="field" style={{ marginTop: 14 }}>
          <div className="lab ctx-lab">
            <span>{Icon.sliders()} Services</span>
            <span className="opt" style={{ fontWeight: 400 }}>port <code className="ctx-mono">{project.port || "—"}</code> injected as <code className="ctx-mono">PORT</code></span>
          </div>
          <div className="hlp" style={{ marginTop: 0, marginBottom: 8 }}>
            The orchestrator supervises these in {repo ? repo.split("/").pop() : "the working dir"} — start/stop them from the Services panel; they outlive the tab.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Dev server</span>
              <input type="text" className="ctx-mono" value={devCmd} placeholder="npm run dev" onChange={(e) => setDevCmd(e.target.value)} />
            </label>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Setup <span className="opt">— optional</span></span>
              <input type="text" className="ctx-mono" value={setupCmd} placeholder="npm install" onChange={(e) => setSetupCmd(e.target.value)} />
            </label>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Test <span className="opt">— optional</span></span>
              <input type="text" className="ctx-mono" value={testCmd} placeholder="npm test" onChange={(e) => setTestCmd(e.target.value)} />
            </label>
          </div>
        </div>
      )}
      {confirmDel && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 16 }}>
          This permanently removes “{project.name}”, its tasks and chat history from the orchestrator. Your code on disk{repo ? ` in ${repo}` : ""} is not touched.
        </div>
      )}
    </Modal>
  );
}

export function SessionsModal({ project, onClose, onJump }: { project: ProjectRow; onClose: () => void; onJump: (taskId: string) => void }) {
  const [sessions, setSessions] = useState<ProjectSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    setSessions(null);
    jget<ProjectSession[]>(`/api/projects/${project.id}/sessions`)
      .then(setSessions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const total = sessions?.length ?? 0;
  return (
    <Modal
      title="Sessions"
      sub={`every agent session run under ${project.name}${sessions ? ` · ${total} total` : ""}`}
      onClose={onClose}
      width={640}
    >
      {error && <ErrNote onRetry={load}>Couldn&apos;t load sessions: {error}</ErrNote>}
      {!sessions && !error && (
        // Skeleton mirroring the session rows below, so the modal doesn't reflow
        // when the real list lands.
        <div className="skel-list" aria-hidden>
          {[52, 38, 46].map((w, i) => (
            <div key={i} className="task" style={{ cursor: "default", marginBottom: 0 }}>
              <div className="task-top">
                <Skel w={9} h={9} r="50%" />
                <Skel w={`${w}%`} h={12} />
                <span style={{ flex: 1 }} />
                <Skel w={70} h={10} />
              </div>
              <div className="task-foot">
                <Skel w={150} h={9} />
              </div>
            </div>
          ))}
        </div>
      )}
      {sessions && total === 0 && (
        <div className="empty" style={{ padding: "24px 8px" }}>
          <div className="e-t">No sessions yet</div>
          <div className="e-s">Start a task to open the project&apos;s first agent session.</div>
        </div>
      )}
      {sessions && total > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {sessions.map((s) => (
            <button
              key={s.id}
              className="task"
              style={{ textAlign: "left", width: "100%" }}
              onClick={() => onJump(s.task_id)}
              title="Open this task"
            >
              <div className="task-top">
                <StatusDot status={s.task_status} running={!s.ended_at} />
                <span className="ttitle">{s.task_title}</span>
                <span className="slabel">Session {s.generation}</span>
              </div>
              <div className="task-foot">
                <span className="activity">{relTime(s.started_at)} · {duration(s.started_at, s.ended_at)} · {s.message_count} msg{s.message_count !== 1 ? "s" : ""}</span>
                <span className="spacer" />
                {s.claude_session_id ? (
                  <span className="activity ctx-mono" title={s.claude_session_id} style={{ fontSize: 11, opacity: 0.7 }}>
                    {s.claude_session_id.slice(0, 8)}
                  </span>
                ) : (
                  <span className="activity" style={{ opacity: 0.5 }}>no session id</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (i: { name: string; sub: string; color: string; context: string; repo_path: string; branch?: string }) => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [sub, setSub] = useState("");
  const [context, setContext] = useState("");
  const [repo, setRepo] = useState("");
  const colors = ["#C2603C", "#3E7CA8", "#6B6F8C", "#5C8C5A", "#9A6E14", "#9E5BA0"];
  const [color, setColor] = useState(colors[0]);
  // Where the code comes from: a fresh/local folder (the greenfield path) or a
  // clone of one of the user's GitHub repos (the onboarding path).
  const [mode, setMode] = useState<"fresh" | "clone">("fresh");
  const [cloneSpec, setCloneSpec] = useState(""); // owner/repo or pasted URL
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const ok = name.trim().length > 0 && !cloning && (mode === "fresh" || cloneSpec.trim().length > 0);

  const submit = async () => {
    if (!ok) return;
    const base = { name: name.trim(), sub: sub.trim() || "app", color, context: context.trim() };
    if (mode === "fresh") { await onCreate({ ...base, repo_path: repo.trim() }); return; }
    // Clone first; only create the project once the repo actually landed.
    setCloning(true);
    setCloneErr(null);
    try {
      const r = await jsend<{ path: string; branch: string }>("/api/github/clone", "POST", { repo: cloneSpec.trim() });
      await onCreate({ ...base, repo_path: r.path, branch: r.branch });
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : String(e));
      setCloning(false);
    }
  };

  return (
    <Modal title="New project" sub="each project is a separate app you're building" onClose={onClose}
      footer={<>
        {cloneErr && <span className="hlp" style={{ color: "var(--red)", margin: 0 }}>⚠ {cloneErr}</span>}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!ok} onClick={submit}>
          {Icon.plus()} {mode === "clone" ? (cloning ? "Cloning…" : "Clone & create") : "Create project"}
        </button>
      </>}>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: 1 }}>
          <div className="lab">Project name</div>
          <input ref={ref} type="text" value={name} placeholder="e.g. Northwind" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ flex: "0 0 150px" }}>
          <div className="lab">Tagline</div>
          <input type="text" value={sub} placeholder="email client" onChange={(e) => setSub(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <div className="lab">Accent color</div>
        <div style={{ display: "flex", gap: 9 }}>
          {colors.map((c) => (
            <button key={c} onClick={() => setColor(c)} style={{ width: 34, height: 34, borderRadius: 9, background: c, outline: color === c ? "2px solid var(--ink)" : "none", outlineOffset: 2, border: "none", cursor: "pointer" }} />
          ))}
        </div>
      </div>
      <div className="field">
        <div className="lab">{Icon.folder()} Code</div>
        <div className="seg">
          <button className={mode === "fresh" ? "on" : ""} onClick={() => setMode("fresh")}>Start fresh</button>
          <button className={mode === "clone" ? "on" : ""} onClick={() => setMode("clone")}>{Icon.github()} Clone from GitHub</button>
        </div>
      </div>
      {mode === "fresh" ? (
        <div className="field">
          <div className="lab">Working dir <span className="opt">— optional, can add later</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={repo} placeholder="/Users/you/code/project" onChange={(e) => setRepo(e.target.value)} />
            <BrowseDirButton initial={repo} onPick={setRepo} />
          </div>
        </div>
      ) : (
        <GitHubClonePicker
          value={cloneSpec}
          onChange={(spec, shortName) => {
            setCloneSpec(spec);
            // Picking a repo names the project after it (only if still unnamed).
            if (shortName && !name.trim()) setName(shortName);
          }}
        />
      )}
      <div className="field">
        <div className="lab">What we&apos;re building <span className="opt">— optional, can add later</span></div>
        <textarea value={context} placeholder="Description, stack, conventions…" onChange={(e) => setContext(e.target.value)} />
      </div>
    </Modal>
  );
}
