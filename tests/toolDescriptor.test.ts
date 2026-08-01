import { describe, it, expect } from "vitest";
import { describeToolUse } from "@/lib/agents/shared";

// describeToolUse has no other coverage, and `file` is threaded through six
// hand-built object literals — an omitted edit drops it silently at runtime
// rather than failing to compile, so pin it at the source.
describe("describeToolUse file field", () => {
  it("returns the path for Write", () => {
    expect(describeToolUse("Write", { file_path: "/w/a.sql", content: "x" }).file).toBe("/w/a.sql");
  });

  it("returns the path for Edit", () => {
    expect(describeToolUse("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }).file).toBe("/w/a.ts");
  });

  it("returns the path for NotebookEdit", () => {
    expect(describeToolUse("NotebookEdit", { notebook_path: "/w/a.ipynb", old_string: "", new_string: "b" }).file).toBe("/w/a.ipynb");
  });

  it("returns the path for Read", () => {
    expect(describeToolUse("Read", { file_path: "/w/a.md" }).file).toBe("/w/a.md");
  });

  // Grep, not Bash, is the load-bearing negative: Bash carries none of
  // file_path/path/notebook_path so it yields undefined under almost any wrong
  // implementation, whereas Grep carries `path` — a DIRECTORY. Hoisting `file`
  // out of the per-tool branches would put a file affordance on every search.
  it("does not set file for Grep, whose `path` is a directory", () => {
    expect(describeToolUse("Grep", { pattern: "x", path: "/w/src" }).file).toBeUndefined();
  });
});
