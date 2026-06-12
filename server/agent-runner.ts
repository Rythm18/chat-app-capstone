/**
 * SdkAgentRunner: drives a real multi-agent research run via the Claude
 * Agent SDK and feeds normalized events into a ChatSession.
 *
 * One long-lived query() per chat session, fed by an async message queue so
 * follow-up user messages continue the same conversation (the SDK emits one
 * `result` message per turn, which our normalizer maps to `done`).
 *
 * Agent prompts are adapted from Anthropic's research-agent demo (explicitly
 * permitted by the assignment), rewritten for this app:
 *  - lead: must ask ONE scoping question via AskUserQuestion on the first
 *    request of a session (exercises the pause/resume flow deterministically)
 *  - data-analyst: markdown tables instead of matplotlib charts (no Bash —
 *    we don't execute arbitrary shell on the host)
 *  - report-writer: markdown report at files/reports/report.md instead of a
 *    PDF (renderable in the browser artifact viewer; no reportlab dependency)
 * Append-style overrides proved insufficient live — the demo's base prompts
 * mention PDF/charts in too many places, so the prompt files themselves are
 * now the rewritten versions.
 */
import { query, type AgentDefinition, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Normalizer, parseAskUserQuestions } from "./normalize.js";
import type { ChatSession, AgentRunner } from "./sessions.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const prompt = (file: string) => readFileSync(join(PROMPTS_DIR, file), "utf-8").trim();

function buildAgents(): Record<string, AgentDefinition> {
  return {
    researcher: {
      description:
        "Use this agent to gather research information on any topic via web search. " +
        "Writes findings to files/research_notes/. Spawn multiple in parallel for distinct subtopics.",
      tools: ["WebSearch", "Write"],
      prompt: prompt("researcher.txt"),
      model: "haiku",
    },
    "data-analyst": {
      description:
        "Use AFTER all researchers complete. Reads files/research_notes/, extracts metrics " +
        "and comparisons, writes a data summary to files/data/.",
      tools: ["Glob", "Read", "Write"],
      prompt: prompt("data_analyst.txt"),
      model: "haiku",
    },
    "report-writer": {
      description:
        "Use LAST, after research and data analysis. Reads all notes and summaries, " +
        "synthesizes the final research brief at files/reports/report.md.",
      tools: ["Write", "Glob", "Read"],
      prompt: prompt("report_writer.txt"),
      model: "haiku",
    },
  };
}

/** Async queue bridging sendUserMessage() calls into query()'s input stream. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private wakeup: (() => void) | null = null;
  private closed = false;

  push(text: string) {
    this.buffer.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wakeup?.();
  }

  close() {
    this.closed = true;
    this.wakeup?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wakeup = resolve));
      this.wakeup = null;
    }
  }
}

export class SdkAgentRunner implements AgentRunner {
  private queue = new MessageQueue();
  private normalizer: Normalizer;

  constructor(private session: ChatSession) {
    this.normalizer = new Normalizer(session.workspaceDir);
    void this.consume();
  }

  send(text: string) {
    this.queue.push(text);
  }

  close() {
    this.queue.close();
  }

  private async consume() {
    const session = this.session;
    try {
      const stream = query({
        prompt: this.queue,
        options: {
          cwd: session.workspaceDir,
          model: "sonnet",
          systemPrompt: prompt("lead_agent.txt"),
          // SDK isolation mode: do NOT load the host machine's ~/.claude
          // settings. Without this, the user's installed plugins leak in as
          // Skill/Workflow tools and the lead wanders off-pipeline (observed
          // live: it invoked a personal "deep-research" skill instead of
          // spawning our researchers).
          settingSources: [],
          // Base tool surface for the whole session: the lead's two tools
          // plus everything the sub-agent definitions need. Each AgentDefinition
          // narrows its own slice; allowedTools below only controls
          // auto-approval, not availability.
          tools: ["Task", "AskUserQuestion", "WebSearch", "Write", "Read", "Glob"],
          allowedTools: ["Task", "AskUserQuestion"],
          agents: buildAgents(),
          maxTurns: 80,
          // Without these two flags the trace UI has nothing to show:
          // sub-agent text/thinking stays internal, and no live deltas flow.
          forwardSubagentText: true,
          includePartialMessages: true,
          permissionMode: "default",
          canUseTool: async (toolName, input, { suggestions }) => {
            if (toolName === "AskUserQuestion") {
              // Suspend the agent on a promise the browser resolves. The SSE
              // stream stays open the whole time — the run is paused, not dead.
              const questions = parseAskUserQuestions(input);
              const answers = await session.askUser(this.currentAskAgentId(input), questions);
              return { behavior: "allow", updatedInput: { questions, answers } };
            }
            return { behavior: "allow", updatedInput: input, suggestions };
          },
        },
      });

      for await (const msg of stream) {
        for (const body of this.normalizer.handle(msg)) {
          session.emit(body);
        }
      }
    } catch (err) {
      session.emit({
        type: "error",
        agentId: "root",
        message: err instanceof Error ? err.message : String(err),
        source: "server",
      });
    }
  }

  /** AskUserQuestion is orchestrator-only in our agent set (sub-agents have
   *  no access to it), so questions always belong to the root node. */
  private currentAskAgentId(_input: unknown): string {
    return "root";
  }
}
