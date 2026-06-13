/**
 * ChatSession: one user-facing chat = one session.
 *
 * Responsibilities:
 *  - stamp normalized event bodies with the envelope (seq / runId / ts)
 *  - keep the full event log so reconnecting clients can replay from
 *    Last-Event-ID (SSE id == seq)
 *  - fan events out to live SSE subscribers
 *  - hold pending ask_user questions: the runner blocks on a promise here
 *    while the stream stays open, until the browser POSTs an answer
 *
 * The session is runner-agnostic: a runner is anything that accepts user
 * messages and emits normalized events (real SDK run or fixture replay).
 */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type {
  AgentEvent,
  AgentEventBody,
  AskUserQuestionItem,
} from "../shared/events.js";

export interface AgentRunner {
  /** Deliver a user chat message to the agent. */
  send(text: string): void;
  /** Stop the current run; the session stays usable for new messages. */
  interrupt(): void | Promise<void>;
  close(): void;
}

interface PendingQuestion {
  agentId: string;
  resolve: (answers: Record<string, string>) => void;
}

export class ChatSession {
  readonly id: string;
  /** Whether this session replays the fixture (mock) or runs the live SDK.
   *  Recorded so a restored session re-attaches the right runner. */
  readonly mock: boolean;
  /** Absolute directory agents write artifacts into (artifact downloads are
   *  served from here, and only from here). */
  workspaceDir: string;

  private events: AgentEvent[] = [];
  private seq = 0;
  private runCounter = 0;
  private currentRunId = "run-0";
  private subscribers = new Set<ServerResponse>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private runner: AgentRunner | null = null;
  /** Runs that have received their terminal `done` event. */
  private doneRunIds = new Set<string>();
  /** Durable sink for emitted events (disk append); null = in-memory only. */
  private persist: ((event: AgentEvent) => void) | null = null;

  constructor(workspaceDir: string, opts: { id?: string; mock?: boolean } = {}) {
    this.id = opts.id ?? randomUUID();
    this.mock = opts.mock ?? false;
    this.workspaceDir = workspaceDir;
  }

  attachRunner(runner: AgentRunner) {
    this.runner = runner;
  }

  hasRunner(): boolean {
    return this.runner !== null;
  }

  /** Wire the durable event sink. Set before hydrate/emit. */
  setPersist(fn: (event: AgentEvent) => void) {
    this.persist = fn;
  }

  // -- persistence ----------------------------------------------------------

  /** Rebuild in-memory state from a persisted event log, without
   *  re-persisting or broadcasting (there are no subscribers yet). The seq
   *  counter and run bookkeeping continue from where the log left off. */
  hydrate(events: AgentEvent[]) {
    this.events = events.slice();
    this.seq = events.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
    let maxRun = 0;
    for (const e of events) {
      if (e.type === "done") this.doneRunIds.add(e.runId);
      const m = /^run-(\d+)$/.exec(e.runId);
      if (m) maxRun = Math.max(maxRun, Number(m[1]));
    }
    this.runCounter = maxRun;
    this.currentRunId = events.length ? events[events.length - 1].runId : "run-0";
  }

  /** Runs are sequential, so at most the latest run can have been mid-flight
   *  when the process died. If it started but never reached `done`, mark it
   *  failed so a restored session shows no eternal spinners (and offers the
   *  user a retry). These synthetic events persist like any other. */
  finalizeInterruptedRuns() {
    if (this.doneRunIds.has(this.currentRunId)) return;
    const started = this.events.some(
      (e) => e.runId === this.currentRunId && e.type === "run_started",
    );
    if (!started) return;
    this.emit({
      type: "error",
      agentId: "root",
      message: "Run interrupted by a server restart.",
      source: "server",
    });
    this.emit({
      type: "done",
      agentId: "root",
      status: "error",
      resultText: "Run interrupted by a server restart.",
      durationMs: 0,
      numTurns: 0,
      costUsd: null,
    });
  }

  // -- inbound (from HTTP) --------------------------------------------------

  sendUserMessage(text: string) {
    if (!this.runner) throw new Error("session has no runner attached");
    this.runCounter += 1;
    this.currentRunId = `run-${this.runCounter}`;
    // Emitted by the server, not the SDK: the UI shows the run instantly,
    // before the model produces its first token.
    this.emit({ type: "run_started", agentId: "root", userMessage: text });
    this.runner.send(text);
  }

  /** Stop the in-flight run. Unparks any pending ask_user first (an agent
   *  frozen inside canUseTool can't process the interrupt), then asks the
   *  runner to interrupt. If the SDK's terminal result doesn't arrive
   *  shortly, emit a synthetic `done` so the UI never spins forever. */
  interrupt() {
    for (const [questionId, pending] of this.pendingQuestions) {
      this.pendingQuestions.delete(questionId);
      this.emit({
        type: "ask_user_answered",
        agentId: pending.agentId,
        questionId,
        answers: {},
      });
      pending.resolve({});
    }
    this.emit({
      type: "error",
      agentId: "root",
      message: "Run stopped by user.",
      source: "server",
    });
    const runAtInterrupt = this.currentRunId;
    void this.runner?.interrupt();
    setTimeout(() => {
      if (this.currentRunId === runAtInterrupt && !this.doneRunIds.has(runAtInterrupt)) {
        this.emit({
          type: "done",
          agentId: "root",
          status: "error",
          resultText: "Run stopped by user.",
          durationMs: 0,
          numTurns: 0,
          costUsd: null,
        });
      }
    }, 5000).unref?.();
  }

  /** Resolve a pending ask_user question. Returns false if unknown id. */
  answerQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    this.pendingQuestions.delete(questionId);
    this.emit({
      type: "ask_user_answered",
      agentId: pending.agentId,
      questionId,
      answers,
    });
    pending.resolve(answers);
    return true;
  }

  // -- outbound (to runner) ---------------------------------------------------

  /** Emit an ask_user event and block until the browser answers it. */
  askUser(agentId: string, questions: AskUserQuestionItem[]): Promise<Record<string, string>> {
    const questionId = randomUUID();
    return new Promise((resolve) => {
      this.pendingQuestions.set(questionId, { agentId, resolve });
      this.emit({ type: "ask_user", agentId, questionId, questions });
    });
  }

  emit(body: AgentEventBody) {
    const event: AgentEvent = {
      ...body,
      seq: this.seq++,
      runId: this.currentRunId,
      ts: new Date().toISOString(),
    };
    if (event.type === "done") this.doneRunIds.add(event.runId);
    this.events.push(event);
    this.persist?.(event);
    const frame = `id: ${event.seq}\nevent: agent_event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.subscribers) {
      res.write(frame);
    }
  }

  // -- SSE ------------------------------------------------------------------

  /** Attach an SSE client, replaying anything it missed. */
  subscribe(res: ServerResponse, lastEventId: number | null) {
    for (const event of this.events) {
      if (lastEventId === null || event.seq > lastEventId) {
        res.write(`id: ${event.seq}\nevent: agent_event\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
    this.subscribers.add(res);
    res.on("close", () => this.subscribers.delete(res));
  }

  heartbeat() {
    for (const res of this.subscribers) res.write(": ping\n\n");
  }

  close() {
    this.runner?.close();
    for (const res of this.subscribers) res.end();
    this.subscribers.clear();
  }
}

export class SessionStore {
  private sessions = new Map<string, ChatSession>();
  private heartbeatTimer: NodeJS.Timeout;

  constructor() {
    // SSE connections through proxies die quietly without traffic.
    this.heartbeatTimer = setInterval(() => {
      for (const s of this.sessions.values()) s.heartbeat();
    }, 25_000);
    this.heartbeatTimer.unref();
  }

  add(session: ChatSession) {
    this.sessions.set(session.id, session);
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }
}
