/**
 * Decoder: folds the normalized event stream into renderable chat state.
 *
 *   state' = decode(state, event)
 *
 * A pure reducer with no framework imports — the browser feeds it into
 * useReducer, the tests feed it event arrays, and both get identical
 * behavior. All updates are immutable (new objects along changed paths) so
 * React re-renders exactly what changed.
 *
 * Structure of the state it builds:
 *
 *   ChatState
 *   └─ runs[]                    one per user message (multi-run stacking)
 *      ├─ nodes: { id -> AgentNode }   flat map; the tree is children-by-id
 *      │  └─ AgentNode: status, ordered steps (thinking / response / tool /
 *      │     ask_user / child-agent markers), streaming-delta buffer
 *      └─ artifacts[]            deduped by path, latest write wins
 *
 * Routing: event.agentId names the node ("root" = orchestrator; otherwise
 * the spawning Task call's tool_use_id — unique even when two sub-agents of
 * the same type run in parallel, which is why agent names are display-only).
 */
import {
  ROOT_AGENT_ID,
  type AgentEvent,
  type AskUserQuestionItem,
} from "./events.js";

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type NodeStatus = "queued" | "running" | "awaiting_input" | "completed" | "failed";
export type RunStatus = "running" | "awaiting_input" | "completed" | "failed";

export interface ToolStep {
  kind: "tool";
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "error";
  output: string | null;
  outputTruncated: boolean;
  elapsedSeconds: number | null;
  ts: string;
}

export interface TextStep {
  kind: "thinking" | "response";
  text: string;
  ts: string;
}

export interface AskUserStep {
  kind: "ask_user";
  questionId: string;
  questions: AskUserQuestionItem[];
  status: "pending" | "answered";
  answers: Record<string, string> | null;
  ts: string;
}

/** Marks where in the parent's flow a child agent was spawned, so the child
 *  node renders inline at the right chronological position. */
export interface ChildRefStep {
  kind: "child";
  nodeId: string;
}

export type Step = ToolStep | TextStep | AskUserStep | ChildRefStep;

export interface AgentNode {
  id: string;
  agentType: string;
  /** 1-based ordinal among same-type agents in this run ("researcher #2"). */
  ordinal: number;
  description: string;
  prompt: string;
  status: NodeStatus;
  children: string[];
  steps: Step[];
  /** In-flight streaming text; superseded by the next completed block. */
  streaming: { blockType: "text" | "thinking"; text: string } | null;
  /** Final report the agent returned to its parent. */
  resultText: string | null;
  startedTs: string | null;
  endedTs: string | null;
}

export interface Artifact {
  path: string;
  name: string;
  sizeBytes: number;
  agentId: string;
  ts: string;
}

export interface RunError {
  agentId: string;
  message: string;
  source: string;
  ts: string;
}

export interface Run {
  runId: string;
  userMessage: string;
  status: RunStatus;
  nodes: Record<string, AgentNode>;
  artifacts: Artifact[];
  errors: RunError[];
  /** Final synthesized answer (from `done`). */
  resultText: string | null;
  durationMs: number | null;
  costUsd: number | null;
  startedTs: string;
}

/** What the system is doing right now — fuels the activity ticker. */
export interface TickerState {
  runId: string;
  agentId: string;
  kind: "thinking" | "writing" | "tool" | "spawning" | "waiting_user";
  detail: string;
  ts: string;
}

export interface PendingQuestion {
  runId: string;
  agentId: string;
  questionId: string;
  questions: AskUserQuestionItem[];
}

export interface ChatState {
  sessionId: string | null;
  model: string | null;
  runs: Run[];
  pendingQuestion: PendingQuestion | null;
  ticker: TickerState | null;
  /** Highest seq applied — handed to SSE reconnects as Last-Event-ID. */
  lastSeq: number;
}

export const initialChatState: ChatState = {
  sessionId: null,
  model: null,
  runs: [],
  pendingQuestion: null,
  ticker: null,
  lastSeq: -1,
};

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

function newNode(
  id: string,
  agentType: string,
  ordinal: number,
  init: Partial<AgentNode> = {},
): AgentNode {
  return {
    id,
    agentType,
    ordinal,
    description: "",
    prompt: "",
    status: "running",
    children: [],
    steps: [],
    streaming: null,
    resultText: null,
    startedTs: null,
    endedTs: null,
    ...init,
  };
}

function newRun(runId: string, userMessage: string, ts: string): Run {
  return {
    runId,
    userMessage,
    status: "running",
    nodes: {
      [ROOT_AGENT_ID]: newNode(ROOT_AGENT_ID, "orchestrator", 1, { startedTs: ts }),
    },
    artifacts: [],
    errors: [],
    resultText: null,
    durationMs: null,
    costUsd: null,
    startedTs: ts,
  };
}

// ---------------------------------------------------------------------------
// Immutable update helpers
// ---------------------------------------------------------------------------

/** Replace the run the event belongs to. Unknown runId (defensive: should
 *  not happen with a well-behaved server) gets an implicit run so no event
 *  is ever dropped on the floor. */
function withRun(state: ChatState, event: AgentEvent, fn: (run: Run) => Run): ChatState {
  const idx = state.runs.findIndex((r) => r.runId === event.runId);
  if (idx === -1) {
    const implicit = newRun(event.runId, "", event.ts);
    return { ...state, runs: [...state.runs, fn(implicit)] };
  }
  const runs = state.runs.slice();
  runs[idx] = fn(runs[idx]);
  return { ...state, runs };
}

function withNode(run: Run, nodeId: string, fn: (node: AgentNode) => AgentNode): Run {
  const node = run.nodes[nodeId] ?? newNode(nodeId, "agent", 1);
  return { ...run, nodes: { ...run.nodes, [nodeId]: fn(node) } };
}

function appendStep(node: AgentNode, step: Step): AgentNode {
  return { ...node, steps: [...node.steps, step] };
}

/** Update the most recent tool step matching toolUseId (scan backwards —
 *  a node rarely has more than a handful of steps). */
function updateToolStep(
  node: AgentNode,
  toolUseId: string,
  fn: (step: ToolStep) => ToolStep,
): AgentNode | null {
  for (let i = node.steps.length - 1; i >= 0; i--) {
    const step = node.steps[i];
    if (step.kind === "tool" && step.toolUseId === toolUseId) {
      const steps = node.steps.slice();
      steps[i] = fn(step);
      return { ...node, steps };
    }
  }
  return null;
}

function ordinalFor(run: Run, agentType: string): number {
  return Object.values(run.nodes).filter((n) => n.agentType === agentType).length + 1;
}

/** Create-or-update a child node and link it under its parent exactly once. */
function upsertChild(
  run: Run,
  parentId: string,
  childId: string,
  fill: { agentType: string; description: string; prompt: string },
  status: NodeStatus,
  ts: string,
): Run {
  const existing = run.nodes[childId];
  let next = withNode(run, childId, (node) =>
    existing
      ? {
          ...node,
          status,
          startedTs: status === "running" ? (node.startedTs ?? ts) : node.startedTs,
          // queued events carry full info; a defensive-created node may not
          description: node.description || fill.description,
          prompt: node.prompt || fill.prompt,
          agentType: node.agentType === "agent" ? fill.agentType : node.agentType,
        }
      : newNode(childId, fill.agentType, ordinalFor(run, fill.agentType), {
          ...fill,
          status,
          startedTs: status === "running" ? ts : null,
        }),
  );
  next = withNode(next, parentId, (parent) =>
    parent.children.includes(childId)
      ? parent
      : { ...appendStep(parent, { kind: "child", nodeId: childId }), children: [...parent.children, childId] },
  );
  return next;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function decode(state: ChatState, event: AgentEvent): ChatState {
  state = { ...state, lastSeq: Math.max(state.lastSeq, event.seq) };

  switch (event.type) {
    case "session_init":
      return {
        ...state,
        sessionId: event.sessionId,
        model: event.model,
      };

    case "run_started":
      return {
        ...state,
        runs: [...state.runs, newRun(event.runId, event.userMessage, event.ts)],
      };

    case "agent_queued":
      return setTicker(
        withRun(state, event, (run) =>
          upsertChild(
            run,
            event.agentId,
            event.childId,
            { agentType: event.agentType, description: event.description, prompt: event.prompt },
            "queued",
            event.ts,
          ),
        ),
        event,
        "spawning",
        event.agentType,
      );

    case "agent_start":
      return setTicker(
        withRun(state, event, (run) =>
          upsertChild(
            run,
            event.agentId,
            event.childId,
            { agentType: event.agentType, description: event.description, prompt: event.prompt },
            "running",
            event.ts,
          ),
        ),
        { ...event, agentId: event.childId },
        "spawning",
        event.agentType,
      );

    case "agent_end":
      return withRun(state, event, (run) =>
        withNode(run, event.agentId, (node) => ({
          ...node,
          status: event.status === "completed" ? "completed" : "failed",
          resultText: event.resultText,
          streaming: null,
          endedTs: event.ts,
        })),
      );

    case "thinking":
    case "response":
      return withRun(state, event, (run) =>
        withNode(run, event.agentId, (node) => ({
          ...appendStep(node, { kind: event.type, text: event.text, ts: event.ts }),
          // The completed block supersedes the deltas that streamed it.
          streaming: null,
        })),
      );

    case "text_delta":
      return setTicker(
        withRun(state, event, (run) =>
          withNode(run, event.agentId, (node) => ({
            ...node,
            streaming: {
              blockType: event.blockType,
              text:
                node.streaming?.blockType === event.blockType
                  ? node.streaming.text + event.text
                  : event.text,
            },
          })),
        ),
        event,
        event.blockType === "thinking" ? "thinking" : "writing",
        "",
      );

    case "tool_start":
      return setTicker(
        withRun(state, event, (run) =>
          withNode(run, event.agentId, (node) =>
            appendStep(node, {
              kind: "tool",
              toolUseId: event.toolUseId,
              tool: event.tool,
              input: event.input,
              status: "running",
              output: null,
              outputTruncated: false,
              elapsedSeconds: null,
              ts: event.ts,
            }),
          ),
        ),
        event,
        "tool",
        event.tool,
      );

    case "tool_end":
      return withRun(state, event, (run) =>
        withNode(run, event.agentId, (node) => {
          const updated = updateToolStep(node, event.toolUseId, (step) => ({
            ...step,
            status: event.isError ? "error" : "ok",
            output: event.output,
            outputTruncated: event.outputTruncated,
          }));
          if (updated) return updated;
          // No matching start (shouldn't happen; be lossless anyway).
          return appendStep(node, {
            kind: "tool",
            toolUseId: event.toolUseId,
            tool: event.tool,
            input: {},
            status: event.isError ? "error" : "ok",
            output: event.output,
            outputTruncated: event.outputTruncated,
            elapsedSeconds: null,
            ts: event.ts,
          });
        }),
      );

    case "tool_progress":
      return setTicker(
        withRun(state, event, (run) =>
          withNode(
            run,
            event.agentId,
            (node) =>
              updateToolStep(node, event.toolUseId, (step) => ({
                ...step,
                elapsedSeconds: event.elapsedSeconds,
              })) ?? node,
          ),
        ),
        event,
        "tool",
        event.tool,
      );

    case "ask_user": {
      const next = withRun(state, event, (run) => ({
        ...withNode(run, event.agentId, (node) => ({
          ...appendStep(node, {
            kind: "ask_user",
            questionId: event.questionId,
            questions: event.questions,
            status: "pending",
            answers: null,
            ts: event.ts,
          }),
          status: "awaiting_input",
        })),
        status: "awaiting_input" as RunStatus,
      }));
      return {
        ...setTicker(next, event, "waiting_user", ""),
        pendingQuestion: {
          runId: event.runId,
          agentId: event.agentId,
          questionId: event.questionId,
          questions: event.questions,
        },
      };
    }

    case "ask_user_answered": {
      const next = withRun(state, event, (run) => ({
        ...withNode(run, event.agentId, (node) => {
          const steps = node.steps.map((step) =>
            step.kind === "ask_user" && step.questionId === event.questionId
              ? { ...step, status: "answered" as const, answers: event.answers }
              : step,
          );
          return { ...node, steps, status: "running" as NodeStatus };
        }),
        status: "running" as RunStatus,
      }));
      return {
        ...next,
        pendingQuestion:
          state.pendingQuestion?.questionId === event.questionId ? null : state.pendingQuestion,
      };
    }

    case "artifact":
      return withRun(state, event, (run) => {
        const artifact: Artifact = {
          path: event.path,
          name: event.name,
          sizeBytes: event.sizeBytes,
          agentId: event.agentId,
          ts: event.ts,
        };
        const idx = run.artifacts.findIndex((a) => a.path === event.path);
        if (idx === -1) return { ...run, artifacts: [...run.artifacts, artifact] };
        const artifacts = run.artifacts.slice();
        artifacts[idx] = artifact; // re-written file: latest write wins
        return { ...run, artifacts };
      });

    case "error":
      return withRun(state, event, (run) => ({
        ...run,
        errors: [
          ...run.errors,
          { agentId: event.agentId, message: event.message, source: event.source, ts: event.ts },
        ],
      }));

    case "done":
      return {
        ...withRun(state, event, (run) => {
          // Terminal: nothing should keep spinning after the run ends.
          const nodes: Record<string, AgentNode> = {};
          for (const [id, node] of Object.entries(run.nodes)) {
            nodes[id] =
              node.status === "completed" || node.status === "failed"
                ? node
                : { ...node, status: event.status === "success" ? "completed" : "failed", endedTs: node.endedTs ?? event.ts, streaming: null };
          }
          return {
            ...run,
            nodes,
            status: event.status === "success" ? "completed" : "failed",
            resultText: event.resultText,
            durationMs: event.durationMs,
            costUsd: event.costUsd,
          };
        }),
        ticker: null,
      };

    default: {
      // Exhaustiveness: a new event type fails compilation here, not silently.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

function setTicker(
  state: ChatState,
  event: { runId: string; agentId: string; ts: string },
  kind: TickerState["kind"],
  detail: string,
): ChatState {
  return {
    ...state,
    ticker: { runId: event.runId, agentId: event.agentId, kind, detail, ts: event.ts },
  };
}

// ---------------------------------------------------------------------------
// Selectors (shared display logic, kept with the state it reads)
// ---------------------------------------------------------------------------

/** "researcher #2" when several of the same type exist, else "researcher". */
export function nodeLabel(run: Run, node: AgentNode): string {
  const sameType = Object.values(run.nodes).filter((n) => n.agentType === node.agentType);
  return sameType.length > 1 ? `${node.agentType} #${node.ordinal}` : node.agentType;
}

/** Node ids of children currently running/awaiting input — the UI marks the
 *  group as parallel when more than one. */
export function activeChildren(run: Run, node: AgentNode): string[] {
  return node.children.filter((id) => {
    const child = run.nodes[id];
    return child && (child.status === "running" || child.status === "awaiting_input");
  });
}

export function latestRun(state: ChatState): Run | null {
  return state.runs.length > 0 ? state.runs[state.runs.length - 1] : null;
}
