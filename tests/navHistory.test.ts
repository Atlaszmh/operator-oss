import { describe, expect, it } from "vitest";
import { reconcileHistory, closeOneLevel, selectionUrl, type HistoryLike, type NavSel } from "../app/orchestrator/navHistory";

// A stand-in for window.history: a stack of entries plus a cursor. pushState
// truncates any forward entries (as real browsers do); back() moves the cursor.
class FakeHistory implements HistoryLike {
  stack: { state: unknown; url: string }[];
  idx: number;
  constructor(initialUrl: string) {
    this.stack = [{ state: null, url: initialUrl }];
    this.idx = 0;
  }
  get state() { return this.idx >= 0 ? this.stack[this.idx].state : null; }
  get url() { return this.idx >= 0 ? this.stack[this.idx].url : "(exit)"; }
  pushState(state: unknown, _t: string, url: string) {
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push({ state, url });
    this.idx++;
  }
  replaceState(state: unknown, _t: string, url: string) {
    if (this.idx >= 0) this.stack[this.idx] = { state, url };
  }
  /** Returns false when Back steps off the end (i.e. leaves the app). */
  back(): boolean { this.idx--; return this.idx >= 0; }
}

const PATH = "/app";
const MOBILE = true;

// Mirrors the mobilePane derivation in Orchestrator.tsx. A feature page is a
// "session" pane like a task is — that's the whole point of the feature landing
// living in the session column.
function paneOf(sel: NavSel): "projects" | "tasks" | "session" | "settings" {
  if (sel.view === "settings") return "settings";
  if (sel.proj && (sel.task || sel.feature)) return "session";
  if (sel.proj) return "tasks";
  return "projects";
}

// One app "tick": selection settled to `sel`, so the persist effect reconciles.
function settle(h: FakeHistory, sel: NavSel) {
  reconcileHistory(h, PATH, sel, MOBILE);
}

// Press Back: browser pops; if still in-app, the popstate handler closes one
// level off the *live* selection, then the effect re-arms. Returns the new pane
// (or "exit"). Mutates `ref` to track the live selection across presses.
function pressBack(h: FakeHistory, ref: { sel: NavSel }): string {
  if (!h.back()) return "exit";
  ref.sel = closeOneLevel(ref.sel);
  settle(h, ref.sel);
  return paneOf(ref.sel);
}

const sel = (proj: string | null, task: string | null, view: NavSel["view"] = "workspace"): NavSel =>
  ({ proj, task, feature: null, view });

/** A feature page open: mutually exclusive with a task (see selectFeature). */
const featSel = (proj: string | null, feature: string | null, view: NavSel["view"] = "workspace"): NavSel =>
  ({ proj, task: null, feature, view });

describe("navHistory — mobile Back via single trap entry", () => {
  it("deep-link to a task: Back steps session → tasks → projects → exit", () => {
    const h = new FakeHistory("/app?project=NB&task=O02");
    const ref = { sel: sel("NB", "O02") };
    settle(h, sel(null, null)); // first effect run: selection still loading
    settle(h, ref.sel);         // async load applies the deep-linked selection
    expect(paneOf(ref.sel)).toBe("session");

    expect(pressBack(h, ref)).toBe("tasks");     // the user's core need: shows all tasks
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("is immune to the live task list churning selTask null↔id (the prod bug)", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);
    settle(h, sel("NB", null)); ref.sel = sel("NB", null);
    settle(h, sel("NB", "O02")); ref.sel = sel("NB", "O02");
    const lenAfterOpen = h.stack.length;

    // Background refreshes flip selTask off and on many times while the task is open.
    for (let i = 0; i < 8; i++) {
      settle(h, sel("NB", null));   // recap clears it
      settle(h, sel("NB", "O02"));  // recap re-selects it
    }
    expect(h.stack.length).toBe(lenAfterOpen); // NO duplicate entries piled up

    ref.sel = sel("NB", "O02");
    expect(pressBack(h, ref)).toBe("tasks");     // one Back still escapes the session
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("drill in by tapping, Back unwinds one level per press (no replay)", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);                       // projects
    settle(h, sel("P", null)); ref.sel = sel("P", null);   // tap project → tasks
    settle(h, sel("P", "T")); ref.sel = sel("P", "T");     // tap task → session

    expect(pressBack(h, ref)).toBe("tasks");      // not back into the task
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("only one trap entry exists at a time regardless of how deep you go", () => {
    const h = new FakeHistory("/app");
    settle(h, sel(null, null));
    settle(h, sel("P", null));
    settle(h, sel("P", "T"));
    const traps = h.stack.filter((e) => (e.state as { trap?: boolean })?.trap).length;
    expect(traps).toBe(1);
  });

  it("settings: Back closes settings back to the workspace", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel("P", null, "settings") };
    settle(h, sel(null, null));
    settle(h, ref.sel);
    expect(paneOf(ref.sel)).toBe("settings");
    expect(pressBack(h, ref)).toBe("tasks");  // settings → workspace (project still open)
  });

  it("desktop (armTrap=false) never pushes a trap — Back is not hijacked", () => {
    const h = new FakeHistory("/app");
    reconcileHistory(h, PATH, sel(null, null), false);
    reconcileHistory(h, PATH, sel("P", null), false);
    reconcileHistory(h, PATH, sel("P", "T"), false);
    expect(h.stack.length).toBe(1); // all replaceState, no new entries
    expect(h.url).toBe("?project=P&task=T"); // URL still mirrored for refresh-restore
  });

  it("selectionUrl mirrors selection for refresh-restore", () => {
    expect(selectionUrl(sel(null, null), "/app")).toBe("/app");
    expect(selectionUrl(sel("P", null), "/app")).toBe("?project=P");
    expect(selectionUrl(sel("P", "T"), "/app")).toBe("?project=P&task=T");
    expect(selectionUrl(sel("P", null, "settings"), "/app")).toBe("?project=P&view=settings");
  });
});

// The feature page is the third thing the session column can show, and until
// this it existed only on desktop: mobilePane ignored `feature`, so tapping a
// feature header selected it and left you staring at the task list.
describe("navHistory — the feature page is a pane too", () => {
  it("opening a feature from the task list shows the session pane, and Back returns to the list", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);
    settle(h, sel("P", null)); ref.sel = sel("P", null);            // tap project → tasks
    settle(h, featSel("P", "F")); ref.sel = featSel("P", "F");      // tap feature header
    expect(paneOf(ref.sel)).toBe("session");

    // Back must land on the TASK LIST, not skip to projects — a feature is a
    // level, so closeOneLevel has to clear it before it clears the project.
    expect(pressBack(h, ref)).toBe("tasks");
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("deep-links to a feature and survives a refresh", () => {
    expect(selectionUrl(featSel("P", "F"), "/app")).toBe("?project=P&feature=F");
    const h = new FakeHistory("/app?project=P&feature=F");
    const ref = { sel: featSel("P", "F") };
    settle(h, sel(null, null)); // first effect: selection still loading
    settle(h, ref.sel);
    expect(paneOf(ref.sel)).toBe("session");
    expect(pressBack(h, ref)).toBe("tasks");
  });

  it("a task outranks a feature in the URL, matching the session column's precedence", () => {
    // selectTask/selectFeature null each other, so this shouldn't arise — but if
    // the invariant ever breaks, the URL must agree with what's rendered.
    const both: NavSel = { proj: "P", task: "T", feature: "F", view: "workspace" };
    expect(selectionUrl(both, "/app")).toBe("?project=P&task=T");
  });

  it("switching between features doesn't pile up history entries", () => {
    const h = new FakeHistory("/app");
    settle(h, sel(null, null));
    settle(h, sel("P", null));
    settle(h, featSel("P", "F1"));
    const len = h.stack.length;
    for (let i = 0; i < 5; i++) {
      settle(h, featSel("P", "F2"));
      settle(h, featSel("P", "F1"));
    }
    expect(h.stack.length).toBe(len);
    expect(h.stack.filter((e) => (e.state as { trap?: boolean })?.trap).length).toBe(1);
  });

  it("closeOneLevel clears a feature before the project", () => {
    expect(closeOneLevel(featSel("P", "F"))).toEqual(featSel("P", null));
    expect(closeOneLevel(featSel("P", null))).toEqual(featSel(null, null));
  });
});
