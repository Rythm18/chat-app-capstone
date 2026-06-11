/**
 * Integration: replay the complete recorded SDK run (fixtures/run-001.jsonl,
 * 468 raw events captured from a real multi-agent research session) through
 * the server-side Normalizer and the client-side decoder, then assert the
 * final tree matches what actually happened in that run:
 *
 *   root (lead)
 *   ├─ ask_user (answered)
 *   ├─ researcher #1  ─ parallel ─┐
 *   ├─ researcher #2  ─ parallel ─┘
 *   ├─ data-analyst      (after both researchers)
 *   └─ report-writer     (last)
 *
 * This is the contract test: if either side drifts from the shared schema,
 * or routing breaks for any real event sequence, this fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Normalizer, parseAskUserQuestions } from "../server/normalize.js";
import { decode, initialChatState, type ChatState } from "../shared/decoder.js";
import type { AgentEvent, AgentEventBody } from "../shared/events.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = join(ROOT, "fixtures", "workspace-001");

/** Mirror the server session: normalize each raw message, stamp envelopes,
 *  and synthesize ask_user/answered from the recorded canUseTool pauses. */
function replayFixture(): { events: AgentEvent[]; states: ChatState[] } {
  const entries = readFileSync(join(ROOT, "fixtures/run-001.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  const normalizer = new Normalizer(WORKSPACE);
  let seq = 0;
  const events: AgentEvent[] = [];
  const push = (body: AgentEventBody, ts: string) =>
    events.push({ ...body, seq: seq++, runId: "run-1", ts });

  push({ type: "run_started", agentId: "root", userMessage: "Research the AI agent framework market" }, entries[0].ts);

  for (const entry of entries) {
    if (entry.channel === "message") {
      for (const body of normalizer.handle(entry.payload)) push(body, entry.ts);
    } else if (entry.channel === "canUseTool" && entry.payload.toolName === "AskUserQuestion") {
      push(
        { type: "ask_user", agentId: "root", questionId: "q-1", questions: parseAskUserQuestions(entry.payload.input) },
        entry.ts,
      );
    } else if (entry.channel === "canUseTool:answer") {
      push({ type: "ask_user_answered", agentId: "root", questionId: "q-1", answers: entry.payload.answers }, entry.ts);
    }
  }

  // Keep every intermediate state so tests can probe mid-run conditions.
  const states: ChatState[] = [];
  let state = initialChatState;
  for (const event of events) {
    state = decode(state, event);
    states.push(state);
  }
  return { events, states };
}

const { events, states } = replayFixture();
const finalState = states[states.length - 1];
const run = finalState.runs[0];

describe("fixture replay: tree shape", () => {
  it("builds root + 4 sub-agent nodes", () => {
    expect(Object.keys(run.nodes)).toHaveLength(5);
    expect(run.nodes["root"].children).toHaveLength(4);
  });

  it("children are researcher, researcher, data-analyst, report-writer in dispatch order", () => {
    const types = run.nodes["root"].children.map((id) => run.nodes[id].agentType);
    expect(types).toEqual(["researcher", "researcher", "data-analyst", "report-writer"]);
  });

  it("the two researchers are distinct nodes with ordinals 1 and 2", () => {
    const researchers = Object.values(run.nodes).filter((n) => n.agentType === "researcher");
    expect(researchers).toHaveLength(2);
    expect(new Set(researchers.map((n) => n.id)).size).toBe(2);
    expect(researchers.map((n) => n.ordinal).sort()).toEqual([1, 2]);
  });

  it("every sub-agent's work landed on its own node (none leaked to root)", () => {
    // Root's only tools were Task dispatches (suppressed into child nodes) —
    // WebSearch/Write/Read activity must all live on sub-agent nodes.
    const rootTools = run.nodes["root"].steps.filter((s) => s.kind === "tool");
    expect(rootTools).toHaveLength(0);
    for (const id of run.nodes["root"].children) {
      expect(run.nodes[id].steps.some((s) => s.kind === "tool")).toBe(true);
    }
  });
});

describe("fixture replay: parallel execution", () => {
  it("both researchers were running simultaneously at some point", () => {
    const wasParallel = states.some((s) => {
      const r = s.runs[0];
      if (!r) return false;
      const running = Object.values(r.nodes).filter(
        (n) => n.agentType === "researcher" && n.status === "running",
      );
      return running.length === 2;
    });
    expect(wasParallel).toBe(true);
  });

  it("data-analyst started only after both researchers completed (sequential-after-parallel)", () => {
    const analystStartIdx = events.findIndex((e) => e.type === "agent_start" && e.agentType === "data-analyst");
    const researcherEnds = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "agent_end" && run.nodes[e.agentId]?.agentType === "researcher")
      .map(({ i }) => i);
    expect(researcherEnds).toHaveLength(2);
    expect(Math.max(...researcherEnds)).toBeLessThan(analystStartIdx);
  });
});

describe("fixture replay: ask_user pause/resume", () => {
  it("the run passed through awaiting_input and resumed", () => {
    const askIdx = events.findIndex((e) => e.type === "ask_user");
    const answeredIdx = events.findIndex((e) => e.type === "ask_user_answered");
    expect(askIdx).toBeGreaterThan(-1);
    expect(answeredIdx).toBeGreaterThan(askIdx);
    expect(states[askIdx].runs[0].status).toBe("awaiting_input");
    expect(states[askIdx].pendingQuestion?.questions[0].question).toContain("angle");
    expect(states[answeredIdx].runs[0].status).toBe("running");
    expect(states[answeredIdx].pendingQuestion).toBeNull();
  });

  it("the question was asked before any researcher was dispatched", () => {
    const askIdx = events.findIndex((e) => e.type === "ask_user");
    const firstSpawnIdx = events.findIndex((e) => e.type === "agent_queued");
    expect(askIdx).toBeLessThan(firstSpawnIdx);
  });
});

describe("fixture replay: terminal state", () => {
  it("run completed with the SDK's final result text", () => {
    expect(run.status).toBe("completed");
    expect(run.resultText).toContain("Research complete");
    expect(run.costUsd).toBeGreaterThan(0);
  });

  it("all nodes ended completed (no eternal spinners)", () => {
    for (const node of Object.values(run.nodes)) {
      expect(node.status).toBe("completed");
    }
  });

  it("artifacts were collected and deduped by path", () => {
    const paths = run.artifacts.map((a) => a.path);
    expect(new Set(paths).size).toBe(paths.length);
    // 6 Write events in the recording, one a rewrite of the same file -> 5 unique
    expect(run.artifacts).toHaveLength(5);
    expect(paths).toContain("files/data/data_summary.md");
    expect(paths.some((p) => p.includes("research_notes/claude_agent_sdk"))).toBe(true);
  });

  it("artifacts are attributed to the agent that wrote them", () => {
    const note = run.artifacts.find((a) => a.path.includes("claude_agent_sdk"));
    expect(note && run.nodes[note.agentId]?.agentType).toBe("researcher");
  });

  it("no event was dropped: lastSeq equals the event count", () => {
    expect(finalState.lastSeq).toBe(events.length - 1);
  });
});
