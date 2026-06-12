/**
 * Decoder unit tests: every event type routes to the correct handler, and
 * nested agent contexts build the right tree shape — including the
 * failure-prone cases: parallel same-type agents, events during ask_user,
 * and interleaved updates that must not clobber each other.
 */
import { describe, it, expect } from "vitest";
import {
  decode,
  initialChatState,
  nodeLabel,
  activeChildren,
  type ChatState,
  type ToolStep,
  type AskUserStep,
} from "../shared/decoder.js";
import type { AgentEvent, AgentEventBody } from "../shared/events.js";

/** Build an enveloped event; seq auto-increments per stream instance. */
function stream() {
  let seq = 0;
  return (body: AgentEventBody, runId = "run-1"): AgentEvent => ({
    ...body,
    seq: seq++,
    runId,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
  });
}

function decodeAll(events: AgentEvent[], from: ChatState = initialChatState): ChatState {
  return events.reduce(decode, from);
}

const run1 = (state: ChatState) => state.runs.find((r) => r.runId === "run-1")!;

describe("event routing", () => {
  it("session_init sets session metadata without creating a run", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "session_init", agentId: "root", sessionId: "s-1", model: "sonnet", agentTypes: ["researcher"] }),
    ]);
    expect(state.sessionId).toBe("s-1");
    expect(state.model).toBe("sonnet");
    expect(state.runs).toHaveLength(0);
  });

  it("run_started creates a run with a running root node", () => {
    const ev = stream();
    const state = decodeAll([ev({ type: "run_started", agentId: "root", userMessage: "hi" })]);
    expect(state.runs).toHaveLength(1);
    expect(run1(state).userMessage).toBe("hi");
    expect(run1(state).status).toBe("running");
    expect(run1(state).nodes["root"].status).toBe("running");
  });

  it("thinking and response append ordered steps to the named node", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "thinking", agentId: "root", text: "hmm" }),
      ev({ type: "response", agentId: "root", text: "plan made" }),
    ]);
    const steps = run1(state).nodes["root"].steps;
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "response"]);
  });

  it("tool_start/tool_end pair onto one step via toolUseId", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "tool_start", agentId: "root", toolUseId: "t1", tool: "WebSearch", input: { query: "x" } }),
      ev({ type: "tool_progress", agentId: "root", toolUseId: "t1", tool: "WebSearch", elapsedSeconds: 3 }),
      ev({ type: "tool_end", agentId: "root", toolUseId: "t1", tool: "WebSearch", output: "results", outputTruncated: false, isError: false }),
    ]);
    const steps = run1(state).nodes["root"].steps;
    expect(steps).toHaveLength(1);
    const tool = steps[0] as ToolStep;
    expect(tool.status).toBe("ok");
    expect(tool.output).toBe("results");
    expect(tool.elapsedSeconds).toBe(3);
  });

  it("tool_end with isError marks the step as error", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "tool_start", agentId: "root", toolUseId: "t1", tool: "WebSearch", input: {} }),
      ev({ type: "tool_end", agentId: "root", toolUseId: "t1", tool: "WebSearch", output: "boom", outputTruncated: false, isError: true }),
    ]);
    expect((run1(state).nodes["root"].steps[0] as ToolStep).status).toBe("error");
  });

  it("text_delta accumulates into the streaming buffer, and the completed block clears it", () => {
    const ev = stream();
    let state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "text_delta", agentId: "root", blockType: "text", text: "Hel" }),
      ev({ type: "text_delta", agentId: "root", blockType: "text", text: "lo" }),
    ]);
    expect(run1(state).nodes["root"].streaming?.text).toBe("Hello");
    state = decode(state, ev({ type: "response", agentId: "root", text: "Hello" }));
    expect(run1(state).nodes["root"].streaming).toBeNull();
    expect(run1(state).nodes["root"].steps.at(-1)).toMatchObject({ kind: "response", text: "Hello" });
  });

  it("error events accumulate on the run without failing nodes", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "error", agentId: "root", message: "rate_limit", source: "api" }),
    ]);
    expect(run1(state).errors).toHaveLength(1);
    expect(run1(state).nodes["root"].status).toBe("running");
  });

  it("done finalizes the run and stops every still-running node", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "agent_queued", agentId: "root", childId: "task-1", agentType: "researcher", description: "d", prompt: "p" }),
      ev({ type: "done", agentId: "root", status: "success", resultText: "final answer", durationMs: 100, numTurns: 2, costUsd: 0.5 }),
    ]);
    expect(run1(state).status).toBe("completed");
    expect(run1(state).resultText).toBe("final answer");
    expect(run1(state).nodes["task-1"].status).toBe("completed");
    expect(state.ticker).toBeNull();
  });

  it("done with error status fails the run", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "done", agentId: "root", status: "error", resultText: "", durationMs: 1, numTurns: 1, costUsd: null }),
    ]);
    expect(run1(state).status).toBe("failed");
  });

  it("tracks lastSeq across all events for SSE resume", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "thinking", agentId: "root", text: "x" }),
    ]);
    expect(state.lastSeq).toBe(1);
  });
});

describe("tree construction and nested routing", () => {
  it("agent_queued -> agent_start -> agent_end walks one node through its lifecycle", () => {
    const ev = stream();
    let state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "agent_queued", agentId: "root", childId: "task-1", agentType: "researcher", description: "find facts", prompt: "long prompt" }),
    ]);
    expect(run1(state).nodes["task-1"].status).toBe("queued");

    state = decode(state, ev({ type: "agent_start", agentId: "root", childId: "task-1", agentType: "researcher", description: "find facts", prompt: "long prompt" }));
    expect(run1(state).nodes["task-1"].status).toBe("running");

    state = decode(state, ev({ type: "agent_end", agentId: "task-1", status: "completed", resultText: "found them" }));
    expect(run1(state).nodes["task-1"].status).toBe("completed");
    expect(run1(state).nodes["task-1"].resultText).toBe("found them");
    // linked exactly once under root despite three lifecycle events
    expect(run1(state).nodes["root"].children).toEqual(["task-1"]);
  });

  it("two parallel same-type agents stay distinct nodes (never keyed by name)", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "agent_queued", agentId: "root", childId: "task-A", agentType: "researcher", description: "topic A", prompt: "" }),
      ev({ type: "agent_queued", agentId: "root", childId: "task-B", agentType: "researcher", description: "topic B", prompt: "" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-A", agentType: "researcher", description: "topic A", prompt: "" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-B", agentType: "researcher", description: "topic B", prompt: "" }),
    ]);
    const run = run1(state);
    expect(run.nodes["root"].children).toEqual(["task-A", "task-B"]);
    expect(run.nodes["task-A"].ordinal).toBe(1);
    expect(run.nodes["task-B"].ordinal).toBe(2);
    expect(nodeLabel(run, run.nodes["task-A"])).toBe("researcher #1");
    expect(nodeLabel(run, run.nodes["task-B"])).toBe("researcher #2");
    expect(activeChildren(run, run.nodes["root"])).toEqual(["task-A", "task-B"]);
  });

  it("interleaved events from parallel agents route independently without clobbering", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-A", agentType: "researcher", description: "", prompt: "" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-B", agentType: "researcher", description: "", prompt: "" }),
      // interleave: A starts a tool, B starts a tool, B finishes, A streams, A finishes
      ev({ type: "tool_start", agentId: "task-A", toolUseId: "tA", tool: "WebSearch", input: { query: "a" } }),
      ev({ type: "tool_start", agentId: "task-B", toolUseId: "tB", tool: "WebSearch", input: { query: "b" } }),
      ev({ type: "tool_end", agentId: "task-B", toolUseId: "tB", tool: "WebSearch", output: "B out", outputTruncated: false, isError: false }),
      ev({ type: "text_delta", agentId: "task-A", blockType: "text", text: "A says" }),
      ev({ type: "tool_end", agentId: "task-A", toolUseId: "tA", tool: "WebSearch", output: "A out", outputTruncated: false, isError: false }),
    ]);
    const run = run1(state);
    const aTool = run.nodes["task-A"].steps.find((s) => s.kind === "tool") as ToolStep;
    const bTool = run.nodes["task-B"].steps.find((s) => s.kind === "tool") as ToolStep;
    expect(aTool.output).toBe("A out");
    expect(bTool.output).toBe("B out");
    expect(run.nodes["task-A"].streaming?.text).toBe("A says");
    expect(run.nodes["task-B"].streaming).toBeNull();
  });

  it("nested sub-agent events land under the sub-agent, not root", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-1", agentType: "researcher", description: "", prompt: "" }),
      ev({ type: "thinking", agentId: "task-1", text: "sub thinking" }),
      ev({ type: "tool_start", agentId: "task-1", toolUseId: "t1", tool: "Write", input: {} }),
    ]);
    expect(run1(state).nodes["task-1"].steps).toHaveLength(2);
    expect(run1(state).nodes["root"].steps.filter((s) => s.kind !== "child")).toHaveLength(0);
  });

  it("a failed sub-agent is marked failed, siblings unaffected", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-A", agentType: "researcher", description: "", prompt: "" }),
      ev({ type: "agent_start", agentId: "root", childId: "task-B", agentType: "researcher", description: "", prompt: "" }),
      ev({ type: "agent_end", agentId: "task-A", status: "failed", resultText: "crashed" }),
    ]);
    expect(run1(state).nodes["task-A"].status).toBe("failed");
    expect(run1(state).nodes["task-B"].status).toBe("running");
  });

  it("events for an unknown run create an implicit run instead of being dropped", () => {
    const ev = stream();
    const state = decodeAll([ev({ type: "thinking", agentId: "root", text: "orphan" }, "run-9")]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].runId).toBe("run-9");
    expect(state.runs[0].nodes["root"].steps).toHaveLength(1);
  });
});

describe("ask_user pause/resume", () => {
  const ev = stream();
  const askEvents = [
    ev({ type: "run_started", agentId: "root", userMessage: "go" }),
    ev({
      type: "ask_user",
      agentId: "root",
      questionId: "q-1",
      questions: [{ question: "Which angle?", header: "Focus", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
    }),
  ];

  it("ask_user suspends the run and surfaces the pending question", () => {
    const state = decodeAll(askEvents);
    expect(run1(state).status).toBe("awaiting_input");
    expect(run1(state).nodes["root"].status).toBe("awaiting_input");
    expect(state.pendingQuestion?.questionId).toBe("q-1");
    expect(state.ticker?.kind).toBe("waiting_user");
  });

  it("done clears a pending question belonging to that run (stopped while paused)", () => {
    const state = decodeAll([
      ...askEvents,
      ev({ type: "done", agentId: "root", status: "error", resultText: "Run stopped by user.", durationMs: 0, numTurns: 0, costUsd: null }),
    ]);
    expect(state.pendingQuestion).toBeNull();
    expect(run1(state).status).toBe("failed");
  });

  it("ask_user_answered resumes the run and records the answers on the step", () => {
    const state = decodeAll([
      ...askEvents,
      ev({ type: "ask_user_answered", agentId: "root", questionId: "q-1", answers: { "Which angle?": "A" } }),
    ]);
    expect(run1(state).status).toBe("running");
    expect(run1(state).nodes["root"].status).toBe("running");
    expect(state.pendingQuestion).toBeNull();
    const step = run1(state).nodes["root"].steps.find((s) => s.kind === "ask_user") as AskUserStep;
    expect(step.status).toBe("answered");
    expect(step.answers).toEqual({ "Which angle?": "A" });
  });
});

describe("artifacts", () => {
  it("collects artifacts and dedupes by path, latest write wins", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "go" }),
      ev({ type: "artifact", agentId: "task-1", path: "files/a.md", name: "a.md", sizeBytes: 10 }),
      ev({ type: "artifact", agentId: "task-1", path: "files/b.md", name: "b.md", sizeBytes: 20 }),
      ev({ type: "artifact", agentId: "task-2", path: "files/a.md", name: "a.md", sizeBytes: 99 }),
    ]);
    const artifacts = run1(state).artifacts;
    expect(artifacts).toHaveLength(2);
    expect(artifacts.find((a) => a.path === "files/a.md")).toMatchObject({ sizeBytes: 99, agentId: "task-2" });
  });
});

describe("multi-run stacking", () => {
  it("each user message gets its own run with an independent tree", () => {
    const ev = stream();
    const state = decodeAll([
      ev({ type: "run_started", agentId: "root", userMessage: "first" }, "run-1"),
      ev({ type: "agent_start", agentId: "root", childId: "t1", agentType: "researcher", description: "", prompt: "" }, "run-1"),
      ev({ type: "done", agentId: "root", status: "success", resultText: "one", durationMs: 1, numTurns: 1, costUsd: null }, "run-1"),
      ev({ type: "run_started", agentId: "root", userMessage: "second" }, "run-2"),
      ev({ type: "agent_start", agentId: "root", childId: "t2", agentType: "data-analyst", description: "", prompt: "" }, "run-2"),
    ]);
    expect(state.runs).toHaveLength(2);
    expect(state.runs[0].status).toBe("completed");
    expect(state.runs[0].nodes["t1"]).toBeDefined();
    expect(state.runs[0].nodes["t2"]).toBeUndefined();
    expect(state.runs[1].status).toBe("running");
    expect(state.runs[1].nodes["t2"]).toBeDefined();
  });
});
