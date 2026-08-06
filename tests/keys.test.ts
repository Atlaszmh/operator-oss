import { describe, it, expect } from "vitest";
import { deriveProjectKey, uniqueProjectKey, normalizeKey, validateKey, displayKey, parseKey } from "@/lib/keys";
import {
  createProject,
  createFeature,
  createTask,
  deleteTask,
  getProject,
  getTask,
  getFeature,
  updateProject,
  listTasks,
  listFeatures,
  listAllTasksLite,
  findFeature,
} from "@/lib/store";
import { getDb, migrate } from "@/lib/db";

// ---------------------------------------------------------------- derivation

describe("project key derivation", () => {
  it("takes initials from a multi-word name", () => {
    expect(deriveProjectKey("Two Minute Empire")).toBe("TME");
  });

  it("caps initials at five", () => {
    expect(deriveProjectKey("a b c d e f g")).toBe("ABCDE");
  });

  it("takes the first four letters of a single word", () => {
    expect(deriveProjectKey("Alloy")).toBe("ALLO");
    expect(deriveProjectKey("Go")).toBe("GO");
  });

  it("splits on punctuation and ignores digits", () => {
    expect(deriveProjectKey("operator-oss")).toBe("OO");
    expect(deriveProjectKey("Project 2000")).toBe("PROJ");
  });

  it("falls back to PRJ when there is nothing usable", () => {
    expect(deriveProjectKey("   ")).toBe("PRJ");
    expect(deriveProjectKey("2000")).toBe("PRJ");
  });

  it("appends a counter when the derived key is taken, case-insensitively", () => {
    expect(uniqueProjectKey("Alloy", new Set())).toBe("ALLO");
    expect(uniqueProjectKey("Alloy", new Set(["allo"]))).toBe("ALLO2");
    expect(uniqueProjectKey("Alloy", new Set(["ALLO", "ALLO2"]))).toBe("ALLO3");
  });

  it("always produces a key validateKey accepts", () => {
    for (const name of ["Alpha Beta Gamma Delta Epsilon", "Go", "   ", "x"]) {
      const key = uniqueProjectKey(name, new Set(["ABGDE", "GO", "PRJ", "X"]));
      expect(validateKey(key), `${name} → ${key}`).toBeNull();
    }
  });
});

describe("key validation", () => {
  it("accepts 1–10 characters starting with a letter", () => {
    expect(validateKey("TME")).toBeNull();
    expect(validateKey("A1")).toBeNull();
    // A project called "X" derives "X" — the validator must accept what the
    // deriver produces, or creating that project makes an unfixable key.
    expect(validateKey("X")).toBeNull();
    expect(validateKey("ABCDEFGHIJ")).toBeNull();
  });

  it("rejects an empty key, a leading digit, punctuation, and too long", () => {
    expect(validateKey("")).not.toBeNull();
    expect(validateKey("1AB")).not.toBeNull();
    expect(validateKey("TM-E")).not.toBeNull();
    expect(validateKey("ABCDEFGHIJK")).not.toBeNull();
  });

  it("normalizes before validating", () => {
    expect(normalizeKey(" tme ")).toBe("TME");
    expect(validateKey(" tme ")).toBeNull();
  });
});

describe("display keys", () => {
  it("puts the type affix between the prefix and the number", () => {
    expect(displayKey("TME", 42, "T")).toBe("TME-T42");
    expect(displayKey("TME", 41, "F")).toBe("TME-F41");
  });

  it("is empty when either half is missing, so the UI renders nothing", () => {
    expect(displayKey("", 42, "T")).toBe("");
    expect(displayKey("TME", 0, "T")).toBe("");
  });

  it("round-trips through parseKey", () => {
    expect(parseKey("tme-t42")).toEqual({ prefix: "TME", kind: "T", seq: 42 });
    expect(parseKey("TME-F41")).toEqual({ prefix: "TME", kind: "F", seq: 41 });
    expect(parseKey("Billing v2")).toBeNull();
    expect(parseKey("TME-T0")).toBeNull();
  });

  it("still reads a pre-affix key, and a prefix that ends in a digit", () => {
    // Keys written down before the affix existed must keep resolving — the
    // number alone is unique within a project.
    expect(parseKey("TME-42")).toEqual({ prefix: "TME", kind: null, seq: 42 });
    // "TME2" is a real derived prefix (uniqueProjectKey's collision suffix), so
    // the split must not eat its digit.
    expect(parseKey("TME2-T7")).toEqual({ prefix: "TME2", kind: "T", seq: 7 });
    expect(parseKey("TME2-7")).toEqual({ prefix: "TME2", kind: null, seq: 7 });
  });

  it("rejects an affix that is neither F nor T", () => {
    expect(parseKey("TME-X9")).toBeNull();
  });
});

// ---------------------------------------------------------------- allocation

describe("key allocation", () => {
  it("gives a new project a unique key derived from its name", () => {
    const a = createProject({ name: "Two Minute Empire" });
    const b = createProject({ name: "Tiny Model Extras" });
    expect(a.key).toBe("TME");
    // Same initials, so the second must not collide.
    expect(b.key).toBe("TME2");
  });

  it("shares one counter between tasks and features", () => {
    const p = createProject({ name: "Shared Counter" });
    const t1 = createTask({ project_id: p.id, title: "one" });
    const f1 = createFeature({ project_id: p.id, name: "a feature" });
    const t2 = createTask({ project_id: p.id, title: "two" });
    expect([t1.seq, f1.seq, t2.seq]).toEqual([1, 2, 3]);
    expect(getProject(p.id)!.key_seq).toBe(3);
  });

  it("never reuses a number after a delete", () => {
    // A recycled identifier is worse than no identifier: TME-2 in a commit
    // message must not silently start pointing at different work.
    const p = createProject({ name: "No Reuse" });
    const first = createTask({ project_id: p.id, title: "one" });
    deleteTask(first.id);
    const second = createTask({ project_id: p.id, title: "two" });
    expect(second.seq).toBe(first.seq + 1);
  });

  it("numbers each project independently", () => {
    const a = createProject({ name: "Alpha One" });
    const b = createProject({ name: "Beta Two" });
    expect(createTask({ project_id: a.id, title: "x" }).seq).toBe(1);
    expect(createTask({ project_id: b.id, title: "y" }).seq).toBe(1);
  });
});

// ---------------------------------------------------------------- read paths

describe("keys on read", () => {
  it("exposes the display key on tasks, features and the palette rows", () => {
    const p = createProject({ name: "Read Paths" });
    const feature = createFeature({ project_id: p.id, name: "Grouped" });
    const task = createTask({ project_id: p.id, title: "Filed", feature_id: feature.id });

    expect(listFeatures(p.id).find((f) => f.id === feature.id)!.key).toBe(`${p.key}-F1`);
    expect(listTasks(p.id).find((t) => t.id === task.id)!.key).toBe(`${p.key}-T2`);
    expect(listAllTasksLite().find((t) => t.id === task.id)!.key).toBe(`${p.key}-T2`);
  });

  it("re-keys everything when the project key changes", () => {
    // The whole point of deriving rather than storing: one write, and every
    // task and feature in the project reads the new key immediately.
    const p = createProject({ name: "Rename Me" });
    const task = createTask({ project_id: p.id, title: "x" });
    expect(listTasks(p.id).find((t) => t.id === task.id)!.key).toBe(`${p.key}-T1`);

    updateProject(p.id, { key: "NEWKEY" });

    expect(listTasks(p.id).find((t) => t.id === task.id)!.key).toBe("NEWKEY-T1");
  });

  it("resolves a feature by key, id, or name", () => {
    const p = createProject({ name: "Resolve Refs" });
    const feature = createFeature({ project_id: p.id, name: "Billing v2" });
    const key = `${p.key}-F${feature.seq}`;

    expect(findFeature(p.id, key)!.id).toBe(feature.id);
    expect(findFeature(p.id, key.toLowerCase())!.id).toBe(feature.id);
    expect(findFeature(p.id, feature.id)!.id).toBe(feature.id);
    expect(findFeature(p.id, "Billing v2")!.id).toBe(feature.id);
    // A key written down before the affix existed still resolves.
    expect(findFeature(p.id, `${p.key}-${feature.seq}`)!.id).toBe(feature.id);
  });

  it("does not resolve a task's key to a feature of the same number", () => {
    // Same argument as the wrong-prefix case below: the caller auto-creates on a
    // miss, and silently handing back the wrong scope is worse than that.
    const p = createProject({ name: "Wrong Scope" });
    const feature = createFeature({ project_id: p.id, name: "Grouped" });

    expect(findFeature(p.id, `${p.key}-T${feature.seq}`)).toBeUndefined();
  });

  it("backfills a pre-key DB, numbering features and tasks together by created_at", () => {
    // Simulate the DB as it was before keys existed: no project key, no seqs,
    // and the one-shot marker not yet set. Then run migrate() as a boot would.
    const p = createProject({ name: "Legacy Backfill" });
    const older = createFeature({ project_id: p.id, name: "Older feature" });
    const newer = createTask({ project_id: p.id, title: "Newer task" });
    const oldest = createTask({ project_id: p.id, title: "Oldest task" });

    const db = getDb();
    db.prepare("UPDATE projects SET key = '', key_seq = 0 WHERE id = ?").run(p.id);
    db.prepare("UPDATE tasks SET seq = 0, created_at = ? WHERE id = ?").run(300, newer.id);
    db.prepare("UPDATE tasks SET seq = 0, created_at = ? WHERE id = ?").run(100, oldest.id);
    db.prepare("UPDATE features SET seq = 0, created_at = ? WHERE id = ?").run(200, older.id);
    db.prepare("DELETE FROM settings WHERE key = 'migrated_keys'").run();

    migrate(db);

    const project = getProject(p.id)!;
    expect(project.key).toBe("LB");
    // One counter, so the numbers follow the order the work was filed —
    // task, then feature, then task — not all features and then all tasks.
    expect(getTask(oldest.id)!.seq).toBe(1);
    expect(getFeature(older.id)!.seq).toBe(2);
    expect(getTask(newer.id)!.seq).toBe(3);
    expect(project.key_seq).toBe(3);
    // And the next thing created continues from there rather than colliding.
    expect(createTask({ project_id: p.id, title: "After" }).seq).toBe(4);
  });

  it("does not resolve another project's key", () => {
    const a = createProject({ name: "Mine Only" });
    const b = createProject({ name: "Yours Only" });
    const feature = createFeature({ project_id: a.id, name: "Shared Name" });

    // Right number, wrong prefix — must not match, and must not fall through to
    // auto-creating confusion in the caller.
    expect(findFeature(b.id, `${a.key}-F${feature.seq}`)).toBeUndefined();
  });
});
