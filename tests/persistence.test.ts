/**
 * Persistence tests:
 *  - the on-disk event log round-trips (write → read back identical)
 *  - ChatSession.hydrate rebuilds seq/run bookkeeping from a log
 *  - finalizeInterruptedRuns marks a mid-flight run failed, but leaves an
 *    already-terminated run alone
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog, loadPersistedSessions, type SessionMeta } from "../server/persistence.js";
import { ChatSession } from "../server/sessions.js";
import type { AgentEvent, AgentEventBody } from "../shared/events.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "da-persist-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ev(body: AgentEventBody, seq: number, runId = "run-1"): AgentEvent {
  return { ...body, seq, runId, ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z` };
}

describe("on-disk log round-trip", () => {
  it("writes meta + events and reads them back identically", () => {
    const dir = tempDir();
    const meta: SessionMeta = {
      id: "sess-A",
      workspaceDir: "/tmp/ws",
      mock: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const log = new SessionLog(dir, meta);
    const events = [
      ev({ type: "run_started", agentId: "root", userMessage: "hi" }, 0),
      ev({ type: "thinking", agentId: "root", text: "hmm" }, 1),
      ev({ type: "done", agentId: "root", status: "success", resultText: "ok", durationMs: 5, numTurns: 1, costUsd: null }, 2),
    ];
    events.forEach((e) => log.append(e));

    const loaded = loadPersistedSessions(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].meta).toEqual(meta);
    expect(loaded[0].events).toEqual(events);
  });

  it("returns nothing for a missing directory", () => {
    expect(loadPersistedSessions(join(tempDir(), "does-not-exist"))).toEqual([]);
  });

  it("skips a torn final line from an abrupt shutdown", () => {
    const dir = tempDir();
    const meta: SessionMeta = { id: "sess-B", workspaceDir: "/tmp/ws", mock: false, createdAt: "t" };
    const log = new SessionLog(dir, meta);
    log.append(ev({ type: "run_started", agentId: "root", userMessage: "x" }, 0));
    // simulate a half-written trailing line from an abrupt shutdown
    appendFileSync(join(dir, "sess-B.jsonl"), '{"seq":1,"type":"thin');
    const loaded = loadPersistedSessions(dir);
    expect(loaded[0].events).toHaveLength(1);
  });

  it("self-heals if the data dir is removed mid-run (never throws)", () => {
    const dir = tempDir();
    const meta: SessionMeta = { id: "sess-C", workspaceDir: "/tmp/ws", mock: false, createdAt: "t" };
    const log = new SessionLog(dir, meta);
    log.append(ev({ type: "run_started", agentId: "root", userMessage: "x" }, 0));
    rmSync(dir, { recursive: true, force: true }); // dir vanishes mid-run
    expect(() => log.append(ev({ type: "thinking", agentId: "root", text: "still here" }, 1))).not.toThrow();
    const loaded = loadPersistedSessions(dir);
    expect(loaded[0].events.at(-1)).toMatchObject({ type: "thinking", text: "still here" });
  });
});

describe("ChatSession.hydrate", () => {
  it("continues seq and run bookkeeping from the log", () => {
    const captured: AgentEvent[] = [];
    const session = new ChatSession("/tmp/ws", { id: "s1", mock: true });
    session.setPersist((e) => captured.push(e));
    session.attachRunner({ send() {}, interrupt() {}, close() {} });
    session.hydrate([
      ev({ type: "run_started", agentId: "root", userMessage: "a" }, 0, "run-1"),
      ev({ type: "done", agentId: "root", status: "success", resultText: "a", durationMs: 1, numTurns: 1, costUsd: null }, 1, "run-1"),
      ev({ type: "run_started", agentId: "root", userMessage: "b" }, 2, "run-2"),
      ev({ type: "done", agentId: "root", status: "success", resultText: "b", durationMs: 1, numTurns: 1, costUsd: null }, 3, "run-2"),
    ]);
    // next emitted event should carry seq 4 and open run-3
    session.sendUserMessage("c");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ type: "run_started", seq: 4, runId: "run-3", userMessage: "c" });
  });
});

describe("finalizeInterruptedRuns", () => {
  it("marks a mid-flight run failed (error + done)", () => {
    const captured: AgentEvent[] = [];
    const session = new ChatSession("/tmp/ws", { id: "s2", mock: true });
    session.setPersist((e) => captured.push(e));
    session.hydrate([
      ev({ type: "run_started", agentId: "root", userMessage: "x" }, 0, "run-1"),
      ev({ type: "agent_start", agentId: "root", childId: "t1", agentType: "researcher", description: "", prompt: "" }, 1, "run-1"),
    ]);
    session.finalizeInterruptedRuns();
    expect(captured.map((e) => e.type)).toEqual(["error", "done"]);
    expect(captured[1]).toMatchObject({ type: "done", status: "error", runId: "run-1" });
  });

  it("leaves an already-terminated run untouched", () => {
    const captured: AgentEvent[] = [];
    const session = new ChatSession("/tmp/ws", { id: "s3", mock: true });
    session.setPersist((e) => captured.push(e));
    session.hydrate([
      ev({ type: "run_started", agentId: "root", userMessage: "x" }, 0, "run-1"),
      ev({ type: "done", agentId: "root", status: "success", resultText: "x", durationMs: 1, numTurns: 1, costUsd: null }, 1, "run-1"),
    ]);
    session.finalizeInterruptedRuns();
    expect(captured).toHaveLength(0);
  });

  it("does nothing for an empty (never-used) session", () => {
    const captured: AgentEvent[] = [];
    const session = new ChatSession("/tmp/ws", { id: "s4", mock: true });
    session.setPersist((e) => captured.push(e));
    session.hydrate([]);
    session.finalizeInterruptedRuns();
    expect(captured).toHaveLength(0);
  });
});
