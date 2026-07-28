import { describe, expect, it } from "vitest";
import { createProject, createTask, listTasks, reorderTasks, updateTask } from "../lib/store";

// Manual task ordering backing the board view (and the list's group order):
// tasks carry a per-project position, listTasks returns position order, and
// reorderTasks persists a client-computed order as positions.
describe("task ordering", () => {
  it("appends new tasks at the end of the project's order", () => {
    const project = createProject({ name: "Board" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    const c = createTask({ project_id: project.id, title: "C" });

    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["A", "B", "C"]);
  });

  it("positions are per-project, not global", () => {
    const p1 = createProject({ name: "P1" });
    const p2 = createProject({ name: "P2" });
    createTask({ project_id: p1.id, title: "P1-A" });
    const first = createTask({ project_id: p2.id, title: "P2-A" });
    expect(first.position).toBe(0);
  });

  it("reorderTasks persists the given order as positions", () => {
    const project = createProject({ name: "Reorder" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    const c = createTask({ project_id: project.id, title: "C" });

    reorderTasks([c.id, a.id, b.id]);
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["C", "A", "B"]);
  });

  it("keeps manual order stable across a status change (board column move)", () => {
    const project = createProject({ name: "Move" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    const c = createTask({ project_id: project.id, title: "C" });

    // Simulate a board drop: B goes to another column at the front of the flat order.
    updateTask(b.id, { status: "in_progress" });
    reorderTasks([b.id, a.id, c.id]);

    const rows = listTasks(project.id);
    expect(rows.map((t) => t.title)).toEqual(["B", "A", "C"]);
    expect(rows.find((t) => t.id === b.id)?.status).toBe("in_progress");
  });

  it("lists suggested tasks after real ones regardless of position", () => {
    const project = createProject({ name: "Sugg" });
    const s = createTask({ project_id: project.id, title: "S", suggested: true });
    const a = createTask({ project_id: project.id, title: "A" });

    // The suggestion was created first (lower position) but sorts after real tasks.
    expect(s.position).toBeLessThan(a.position);
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["A", "S"]);
  });
});
