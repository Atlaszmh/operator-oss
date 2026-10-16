// The task card timer ("working · 20m") counts from state_since, which must move
// only when the visible state changes — not on every cost/outcome write.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createProject, createTask, updateTask } from "@/lib/store";

afterEach(() => vi.useRealTimers());

describe("state_since", () => {
  it("resets on status/running/awaiting changes and nothing else", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = createTask({ project_id: createProject({ name: "StateSince" }).id, title: "x" });

    vi.setSystemTime(1_000);
    expect(updateTask(t.id, { status: "in_progress", running: 1 })!.state_since).toBe(1_000);

    vi.setSystemTime(2_000);
    const mid = updateTask(t.id, { outcome: "did a thing", resolved_model: "opus" })!;
    expect(mid.state_since).toBe(1_000);
    expect(mid.updated_at).toBe(2_000);

    vi.setSystemTime(3_000);
    expect(updateTask(t.id, { running: 0, awaiting_input: 1 })!.state_since).toBe(3_000);
  });
});
