/**
 * Normalizer regression tests for behaviors learned from real runs:
 * artifact-path portability across machines, and the spawn tool's
 * undocumented wire name.
 */
import { describe, it, expect } from "vitest";
import { Normalizer } from "../server/normalize.js";

const assistantWrite = (id: string, filePath: string) => ({
  type: "assistant",
  parent_tool_use_id: "task-1",
  message: {
    content: [
      { type: "tool_use", id, name: "Write", input: { file_path: filePath, content: "x" } },
    ],
  },
});

const writeResult = (id: string) => ({
  type: "user",
  parent_tool_use_id: "task-1",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: "File created successfully" }],
  },
});

describe("artifact path portability", () => {
  it("relativizes paths recorded on a different machine via the workspace name", () => {
    // Grader's clone lives somewhere else than where the fixture was captured.
    const n = new Normalizer("/Users/grader/clone/fixtures/workspace-001");
    n.handle(assistantWrite("w1", "/Users/original/dev/fixtures/workspace-001/files/data/data_summary.md"));
    const events = n.handle(writeResult("w1"));
    const artifact = events.find((e) => e.type === "artifact");
    expect(artifact).toMatchObject({ path: "files/data/data_summary.md" });
  });

  it("relativizes exact-workspace paths and keeps relative paths untouched", () => {
    const n = new Normalizer("/srv/app/runs/session-1");
    n.handle(assistantWrite("w1", "/srv/app/runs/session-1/files/notes/a.md"));
    expect(n.handle(writeResult("w1")).find((e) => e.type === "artifact")).toMatchObject({
      path: "files/notes/a.md",
    });
    n.handle(assistantWrite("w2", "files/notes/b.md"));
    expect(n.handle(writeResult("w2")).find((e) => e.type === "artifact")).toMatchObject({
      path: "files/notes/b.md",
    });
  });
});

describe("spawn tool wire name", () => {
  // Docs say Task; SDK 0.3.x emits Agent. Both must queue a sub-agent node.
  for (const wireName of ["Task", "Agent"]) {
    it(`treats a ${wireName} tool_use as an agent_queued dispatch`, () => {
      const n = new Normalizer("/w");
      const events = n.handle({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "spawn-1",
              name: wireName,
              input: { subagent_type: "researcher", description: "d", prompt: "p" },
            },
          ],
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "agent_queued",
        agentId: "root",
        childId: "spawn-1",
        agentType: "researcher",
      });
      // ...and its eventual result closes the node as agent_end, not tool_end.
      const end = n.handle({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "done" }],
        },
      });
      expect(end[0]).toMatchObject({ type: "agent_end", agentId: "spawn-1", status: "completed" });
    });
  }
});
