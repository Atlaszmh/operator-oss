// The business-facing outcome line: one plain-language sentence per task on
// what it DELIVERED, asked for in every turn's project context and lifted off
// the assistant text into tasks.outcome.
//
// The parser is the whole mechanism (there is no tool call to validate it), so
// it's what's pinned here — plus the instruction that produces it, since a
// prompt that stops naming the marker silently empties the feature.

import { describe, it, expect } from "vitest";
import { extractOutcome, OUTCOME_INSTRUCTION, buildProjectContext } from "@/lib/agents/shared";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";

describe("extractOutcome", () => {
  it("takes the marked line, not the prose around it", () => {
    expect(extractOutcome("Done — tests pass.\n\nOUTCOME: Customers can pay with Apple Pay."))
      .toBe("Customers can pay with Apple Pay.");
  });

  it("survives the markdown agents reach for unprompted", () => {
    for (const line of [
      "**OUTCOME:** Refunds settle same day.",
      "## Outcome: Refunds settle same day.",
      "> outcome: Refunds settle same day.",
      "- Outcome : Refunds settle same day.".replace(" :", ":"),
      "OUTCOME: **Refunds settle same day.**",
    ]) {
      expect(extractOutcome(line), line).toBe("Refunds settle same day.");
    }
  });

  it("returns '' for the messages that don't report one", () => {
    expect(extractOutcome("Reading the config now.")).toBe("");
    expect(extractOutcome("")).toBe("");
    // The word mid-sentence is not a report — the marker is line-anchored.
    expect(extractOutcome("The outcome: we should check with the user first.")).toBe("");
    // Marker with nothing after it isn't a report either.
    expect(extractOutcome("OUTCOME:")).toBe("");
  });

  it("keeps the LAST report in a message that finishes twice", () => {
    expect(extractOutcome("OUTCOME: First pass.\n\nThen I fixed the edge case.\n\nOUTCOME: Second pass."))
      .toBe("Second pass.");
  });

  it("caps a runaway line so it can't bloat the row or the card", () => {
    const out = extractOutcome(`OUTCOME: ${"x".repeat(500)}`);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("the instruction that produces it", () => {
  it("names the exact marker extractOutcome parses", () => {
    // If these drift apart the agent keeps writing a line nobody reads.
    expect(extractOutcome("OUTCOME: it round-trips.")).toBe("it round-trips.");
    expect(OUTCOME_INSTRUCTION).toContain("OUTCOME: <one sentence>");
  });

  it("ships in every task's project context", () => {
    const project = createProject({ name: "Outcomes" });
    const task = createTask({ project_id: project.id, title: "Ship something" });
    expect(buildProjectContext(project, task)).toContain("OUTCOME: <one sentence>");
  });
});

describe("storage", () => {
  it("defaults to '' and holds what the runner writes", () => {
    const project = createProject({ name: "Store" });
    const task = createTask({ project_id: project.id, title: "T" });
    expect(task.outcome).toBe("");
    updateTask(task.id, { outcome: "Support can close tickets without engineering." });
    expect(getTask(task.id)!.outcome).toBe("Support can close tickets without engineering.");
    // An unrelated update must not blank it — the runner only ever passes
    // `outcome` when a turn actually reported one.
    updateTask(task.id, { status: "done" });
    expect(getTask(task.id)!.outcome).toBe("Support can close tickets without engineering.");
  });
});
