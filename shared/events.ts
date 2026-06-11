/**
 * Normalized agent event schema — the contract between the server, the
 * browser decoder, and the tests.
 *
 * The server consumes raw Claude Agent SDK messages (30+ union members, many
 * irrelevant to a trace UI) and normalizes them into these ~13 event types
 * before streaming to the browser. The browser never sees a raw SDK message.
 *
 * Routing model: every event names the trace-tree node it belongs to via
 * `agentId`. The orchestrator (lead agent) is the root node with id "root".
 * A sub-agent's node id is the `tool_use_id` of the Task call that spawned
 * it — the only identifier that stays unique when the orchestrator runs two
 * sub-agents of the same type in parallel. Agent *names* are display labels,
 * never routing keys.
 */

/** Node id of the orchestrator in every trace tree. */
export const ROOT_AGENT_ID = "root";

/** Fields stamped by the server session when an event is emitted. */
export interface EventEnvelope {
  /** Monotonic per-session sequence. Doubles as the SSE event id, so a
   *  reconnecting client can resume with Last-Event-ID. */
  seq: number;
  /** One run = one user message through to its `done` event. */
  runId: string;
  /** Server-side emit time, ISO 8601. */
  ts: string;
}

/** Fields every event body shares. */
interface BodyBase {
  /** Trace-tree node this event belongs to (see routing model above). */
  agentId: string;
}

// ---------------------------------------------------------------------------
// Session / run lifecycle
// ---------------------------------------------------------------------------

/** SDK session is live (from system/init). Render immediately — the user must
 *  see activity before the first model token arrives. */
export interface SessionInitBody extends BodyBase {
  type: "session_init";
  sessionId: string;
  model: string;
  /** Sub-agent types available to the orchestrator. */
  agentTypes: string[];
}

/** A user message was accepted and a run began. Emitted by the server itself,
 *  not derived from the SDK, so the UI gets feedback at t=0. */
export interface RunStartedBody extends BodyBase {
  type: "run_started";
  userMessage: string;
}

/** Terminal event of a run (from the SDK result message). */
export interface RunDoneBody extends BodyBase {
  type: "done";
  status: "success" | "error";
  /** Final synthesized answer text. */
  resultText: string;
  durationMs: number;
  numTurns: number;
  costUsd: number | null;
}

/** Something failed — an API error on a message, a failed run, or a server
 *  exception. `agentId` points at the node that failed (root if unknown). */
export interface RunErrorBody extends BodyBase {
  type: "error";
  message: string;
  /** Where the error surfaced, for display grouping. */
  source: "api" | "tool" | "agent" | "server";
}

// ---------------------------------------------------------------------------
// Agent (sub-agent) lifecycle
// ---------------------------------------------------------------------------

/** The orchestrator dispatched a Task whose sub-agent hasn't begun running
 *  yet (the Task tool_use block precedes the task_started lifecycle event —
 *  with several parallel dispatches the gap is real). `agentId` is the
 *  PARENT node; `childId` is the new node's id. */
export interface AgentQueuedBody extends BodyBase {
  type: "agent_queued";
  childId: string;
  agentType: string;
  description: string;
  prompt: string;
}

/** A sub-agent was spawned. `agentId` is the PARENT node; `childId` is the
 *  new node (the spawning Task call's tool_use_id). */
export interface AgentStartBody extends BodyBase {
  type: "agent_start";
  childId: string;
  /** e.g. "researcher" — display label, not a routing key. */
  agentType: string;
  /** Short human description of the task ("Claude Agent SDK research"). */
  description: string;
  /** Full prompt given to the sub-agent (shown on node expand). */
  prompt: string;
}

/** A sub-agent finished. `agentId` is the node that ended. */
export interface AgentEndBody extends BodyBase {
  type: "agent_end";
  status: "completed" | "failed";
  /** Sub-agent's final report back to its parent, if any. */
  resultText: string;
}

// ---------------------------------------------------------------------------
// Agent activity (text, thinking, tools)
// ---------------------------------------------------------------------------

/** A completed thinking block. */
export interface ThinkingBody extends BodyBase {
  type: "thinking";
  text: string;
}

/** A completed text block — the agent talking (root: chat reply text;
 *  sub-agent: report-back text shown in its trace node). */
export interface ResponseBody extends BodyBase {
  type: "response";
  text: string;
}

/** Incremental streaming text, for live typing and the activity ticker.
 *  Decoders append deltas to the node's in-progress buffer; the buffer is
 *  replaced by the next complete `thinking`/`response` block. */
export interface TextDeltaBody extends BodyBase {
  type: "text_delta";
  blockType: "text" | "thinking";
  text: string;
}

/** A tool call started. Suppressed for Task and AskUserQuestion, which emit
 *  agent_start / ask_user instead. */
export interface ToolStartBody extends BodyBase {
  type: "tool_start";
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
}

/** A tool call finished. */
export interface ToolEndBody extends BodyBase {
  type: "tool_end";
  toolUseId: string;
  tool: string;
  /** Stringified output, truncated server-side if huge. */
  output: string;
  outputTruncated: boolean;
  isError: boolean;
}

/** Periodic heartbeat for a long-running tool (activity ticker fuel). */
export interface ToolProgressBody extends BodyBase {
  type: "tool_progress";
  toolUseId: string;
  tool: string;
  elapsedSeconds: number;
}

// ---------------------------------------------------------------------------
// ask_user (AskUserQuestion via canUseTool)
// ---------------------------------------------------------------------------

export interface AskUserOption {
  label: string;
  description: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserOption[];
}

/** An agent paused to ask the user. The run is suspended (stream stays open)
 *  until the client POSTs an answer for `questionId`. */
export interface AskUserBody extends BodyBase {
  type: "ask_user";
  questionId: string;
  questions: AskUserQuestionItem[];
}

/** The user's answer was delivered and the agent resumed. */
export interface AskUserAnsweredBody extends BodyBase {
  type: "ask_user_answered";
  questionId: string;
  /** question text -> chosen label(s), comma-joined for multiSelect. */
  answers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** An agent produced an output file (derived from successful Write calls). */
export interface ArtifactBody extends BodyBase {
  type: "artifact";
  /** Path relative to the session workspace, e.g. "files/reports/report.md". */
  path: string;
  /** Base name for display, e.g. "report.md". */
  name: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Union + helpers
// ---------------------------------------------------------------------------

export type AgentEventBody =
  | SessionInitBody
  | RunStartedBody
  | RunDoneBody
  | RunErrorBody
  | AgentQueuedBody
  | AgentStartBody
  | AgentEndBody
  | ThinkingBody
  | ResponseBody
  | TextDeltaBody
  | ToolStartBody
  | ToolEndBody
  | ToolProgressBody
  | AskUserBody
  | AskUserAnsweredBody
  | ArtifactBody;

export type AgentEvent = EventEnvelope & AgentEventBody;

export type AgentEventType = AgentEventBody["type"];
