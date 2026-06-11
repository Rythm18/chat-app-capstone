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
  close(): void;
}

interface PendingQuestion {
  agentId: string;
  resolve: (answers: Record<string, string>) => void;
}

export class ChatSession {
  readonly id: string;
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

  constructor(workspaceDir: string) {
    this.id = randomUUID();
    this.workspaceDir = workspaceDir;
  }

  attachRunner(runner: AgentRunner) {
    this.runner = runner;
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
    this.events.push(event);
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
