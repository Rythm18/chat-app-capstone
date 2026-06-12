/**
 * Normalizer: raw Claude Agent SDK messages -> normalized AgentEventBody[].
 *
 * Stateful by necessity — two routing facts are only learnable from earlier
 * messages, so the normalizer carries a small amount of memory across calls:
 *
 *  1. Which node emitted a tool call. A tool_result only carries the
 *     tool_use_id, so we remember toolUseId -> {agentId, tool, input} from
 *     the tool_use block that started it.
 *  2. Which tool_use_ids are Task spawns. Their results must become
 *     agent_end events (closing a tree node), not plain tool_end events.
 *
 * Everything else is a pure mapping. One instance per chat session.
 */
import { basename, isAbsolute, relative, sep } from "node:path";
import {
  ROOT_AGENT_ID,
  type AgentEventBody,
  type AskUserQuestionItem,
} from "../shared/events.js";

/** Tool outputs above this size are truncated before streaming to the browser. */
const MAX_TOOL_OUTPUT_CHARS = 16_000;

/** Tool names that dispatch a sub-agent. The docs call it Task; SDK 0.3.x
 *  emits it as Agent on the wire (observed in fixtures/run-001.jsonl) —
 *  accept both rather than assuming docs match reality. */
const SPAWN_TOOLS = new Set(["Task", "Agent"]);

/** Tools whose start is represented by a richer dedicated event instead. */
const SUPPRESSED_TOOL_STARTS = new Set(["AskUserQuestion"]);

interface PendingToolCall {
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
}

export class Normalizer {
  private pendingTools = new Map<string, PendingToolCall>();
  private taskSpawnIds = new Set<string>();

  /** @param workspaceDir absolute session workspace; agents may Write with
   *  absolute paths, but artifact events carry workspace-relative paths so
   *  the browser can fetch them via the artifacts endpoint. */
  constructor(private workspaceDir: string = "") {}

  private toWorkspacePath(filePath: string): string {
    if (!isAbsolute(filePath)) return filePath;
    if (!this.workspaceDir) return filePath;
    const rel = relative(this.workspaceDir, filePath);
    if (!rel.startsWith("..")) return rel;
    // Recorded fixtures carry absolute paths from the machine they were
    // captured on; exact relativization fails everywhere else. Fall back to
    // matching the workspace directory NAME inside the path, so replays are
    // portable across machines.
    const marker = sep + basename(this.workspaceDir) + sep;
    const idx = filePath.lastIndexOf(marker);
    if (idx !== -1) return filePath.slice(idx + marker.length);
    return filePath;
  }

  /** Map a raw SDK message to zero or more normalized event bodies. */
  handle(msg: any): AgentEventBody[] {
    switch (msg.type) {
      case "system":
        return this.handleSystem(msg);
      case "assistant":
        return this.handleAssistant(msg);
      case "user":
        return this.handleUser(msg);
      case "stream_event":
        return this.handleStreamEvent(msg);
      case "tool_progress":
        return this.handleToolProgress(msg);
      case "result":
        return this.handleResult(msg);
      default:
        // status, rate limits, hook chatter, task notifications… — noise for
        // a trace UI. Dropped deliberately rather than accidentally.
        return [];
    }
  }

  private agentIdFor(parentToolUseId: string | null | undefined): string {
    return parentToolUseId ?? ROOT_AGENT_ID;
  }

  private handleSystem(msg: any): AgentEventBody[] {
    switch (msg.subtype) {
      case "init":
        return [
          {
            type: "session_init",
            agentId: ROOT_AGENT_ID,
            sessionId: msg.session_id,
            model: msg.model,
            agentTypes: msg.agents ?? [],
          },
        ];

      case "task_started": {
        // A sub-agent is live. The node id is the spawning Task call's
        // tool_use_id; its parent is whichever node emitted that Task call.
        this.taskSpawnIds.add(msg.tool_use_id);
        const parent =
          this.pendingTools.get(msg.tool_use_id)?.agentId ?? ROOT_AGENT_ID;
        return [
          {
            type: "agent_start",
            agentId: parent,
            childId: msg.tool_use_id,
            agentType: msg.subagent_type ?? "agent",
            description: msg.description ?? "",
            prompt: msg.prompt ?? "",
          },
        ];
      }

      default:
        return [];
    }
  }

  private handleAssistant(msg: any): AgentEventBody[] {
    const agentId = this.agentIdFor(msg.parent_tool_use_id);
    const events: AgentEventBody[] = [];

    if (msg.error) {
      events.push({
        type: "error",
        agentId,
        message: `API error: ${msg.error}`,
        source: "api",
      });
    }

    for (const block of msg.message?.content ?? []) {
      switch (block.type) {
        case "thinking":
          events.push({ type: "thinking", agentId, text: block.thinking });
          break;
        case "text":
          events.push({ type: "response", agentId, text: block.text });
          break;
        case "tool_use":
          this.pendingTools.set(block.id, {
            agentId,
            tool: block.name,
            input: block.input ?? {},
          });
          if (SPAWN_TOOLS.has(block.name)) {
            // Register the spawn here, not just at task_started: if the
            // sub-agent dies before starting, its tool_result must still
            // close the node (agent_end), not appear as a stray tool_end.
            this.taskSpawnIds.add(block.id);
            // Dispatch precedes execution: the node exists as "queued" until
            // its task_started event flips it to running.
            events.push({
              type: "agent_queued",
              agentId,
              childId: block.id,
              agentType: String(block.input?.subagent_type ?? "agent"),
              description: String(block.input?.description ?? ""),
              prompt: String(block.input?.prompt ?? ""),
            });
          } else if (!SUPPRESSED_TOOL_STARTS.has(block.name)) {
            events.push({
              type: "tool_start",
              agentId,
              toolUseId: block.id,
              tool: block.name,
              input: block.input ?? {},
            });
          }
          break;
        // redacted_thinking and other block types carry nothing renderable
      }
    }
    return events;
  }

  private handleUser(msg: any): AgentEventBody[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return []; // plain user text echo — not ours
    const events: AgentEventBody[] = [];

    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const call = this.pendingTools.get(block.tool_use_id);
      this.pendingTools.delete(block.tool_use_id);
      const output = stringifyToolResult(block.content);
      const isError = block.is_error === true;

      if (this.taskSpawnIds.has(block.tool_use_id)) {
        // A sub-agent's final report — close its node.
        events.push({
          type: "agent_end",
          agentId: block.tool_use_id,
          status: isError ? "failed" : "completed",
          resultText: output.text,
        });
        continue;
      }

      if (call?.tool === "AskUserQuestion") continue; // ask_user_answered covers it

      events.push({
        type: "tool_end",
        agentId: call?.agentId ?? this.agentIdFor(msg.parent_tool_use_id),
        toolUseId: block.tool_use_id,
        tool: call?.tool ?? "unknown",
        output: output.text,
        outputTruncated: output.truncated,
        isError,
      });

      if (isError) continue;

      // A successful Write is an artifact the user will want to open.
      const filePath = call?.tool === "Write" ? call.input["file_path"] : null;
      if (typeof filePath === "string") {
        const contentStr = call?.input["content"];
        events.push({
          type: "artifact",
          agentId: call!.agentId,
          path: this.toWorkspacePath(filePath),
          name: basename(filePath),
          sizeBytes: typeof contentStr === "string" ? contentStr.length : 0,
        });
      }
    }
    return events;
  }

  private handleStreamEvent(msg: any): AgentEventBody[] {
    const ev = msg.event;
    if (ev?.type !== "content_block_delta") return [];
    const agentId = this.agentIdFor(msg.parent_tool_use_id);
    switch (ev.delta?.type) {
      case "text_delta":
        return [{ type: "text_delta", agentId, blockType: "text", text: ev.delta.text }];
      case "thinking_delta":
        return [{ type: "text_delta", agentId, blockType: "thinking", text: ev.delta.thinking }];
      default:
        return []; // input_json_delta, signature_delta — not displayable text
    }
  }

  private handleToolProgress(msg: any): AgentEventBody[] {
    return [
      {
        type: "tool_progress",
        agentId: this.agentIdFor(msg.parent_tool_use_id),
        toolUseId: msg.tool_use_id,
        tool: msg.tool_name,
        elapsedSeconds: msg.elapsed_time_seconds,
      },
    ];
  }

  private handleResult(msg: any): AgentEventBody[] {
    return [
      {
        type: "done",
        agentId: ROOT_AGENT_ID,
        status: msg.is_error ? "error" : "success",
        resultText: typeof msg.result === "string" ? msg.result : "",
        durationMs: msg.duration_ms ?? 0,
        numTurns: msg.num_turns ?? 0,
        costUsd: msg.total_cost_usd ?? null,
      },
    ];
  }
}

/** Flatten a tool_result content payload (string | block array) to text. */
function stringifyToolResult(content: unknown): { text: string; truncated: boolean } {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b: any) => (b?.type === "text" ? b.text : `[${b?.type ?? "unknown"}]`))
      .join("\n");
  } else if (content == null) {
    text = "";
  } else {
    text = JSON.stringify(content);
  }
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    return { text: text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n… [truncated]", truncated: true };
  }
  return { text, truncated: false };
}

/** Parse the questions array out of a raw AskUserQuestion tool input. */
export function parseAskUserQuestions(input: unknown): AskUserQuestionItem[] {
  const questions = (input as any)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((q: any) => ({
    question: String(q?.question ?? ""),
    header: String(q?.header ?? ""),
    multiSelect: q?.multiSelect === true,
    options: Array.isArray(q?.options)
      ? q.options.map((o: any) => ({
          label: String(o?.label ?? ""),
          description: String(o?.description ?? ""),
        }))
      : [],
  }));
}
