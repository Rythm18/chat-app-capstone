/**
 * SdkAgentRunner: drives a real multi-agent research run via the Claude
 * Agent SDK and feeds normalized events into a ChatSession.
 *
 * One long-lived query() per chat session, fed by an async message queue so
 * follow-up user messages continue the same conversation (the SDK emits one
 * `result` message per turn, which our normalizer maps to `done`).
 *
 * Agent prompts are Anthropic's research-agent demo prompts (explicitly
 * permitted by the assignment) with three overrides appended:
 *  - lead: ask ONE scoping question via AskUserQuestion when the request is
 *    broad or ambiguous (exercises the pause/resume flow)
 *  - data-analyst: markdown tables instead of matplotlib charts (no Bash —
 *    we don't execute arbitrary shell on the host)
 *  - report-writer: markdown report instead of PDF (renderable in the
 *    browser artifact viewer; no reportlab dependency)
 */
import { query, type AgentDefinition, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Normalizer, parseAskUserQuestions } from "./normalize.js";
import type { ChatSession, AgentRunner } from "./sessions.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const prompt = (file: string) => readFileSync(join(PROMPTS_DIR, file), "utf-8").trim();

const LEAD_OVERRIDE = `

**IMPORTANT OVERRIDES:**
- If the research request is broad, ambiguous, or could be approached from
  several angles, ask the user exactly ONE scoping question FIRST using the
  AskUserQuestion tool (2-4 concrete options). Use the answer to shape the
  subtopics. Never ask questions as plain text — only through AskUserQuestion.
- If the request is already narrow and specific, skip the question and
  dispatch researchers immediately.
- Spawn researchers for distinct subtopics IN PARALLEL (multiple Task calls
  in one turn), then data-analyst, then report-writer.`;

const DATA_ANALYST_OVERRIDE = `

**IMPORTANT OVERRIDE:** Do NOT generate charts and do NOT use Bash or Python.
Write your quantitative analysis as markdown tables in files/data/data_summary.md.`;

const REPORT_WRITER_OVERRIDE = `

**IMPORTANT OVERRIDE:** Produce the final report as a MARKDOWN file at
files/reports/report.md. Do NOT create a PDF. Do NOT use Bash, reportlab, or
any Skill.`;

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
      prompt: prompt("data_analyst.txt") + DATA_ANALYST_OVERRIDE,
      model: "haiku",
    },
    "report-writer": {
      description:
        "Use LAST, after research and data analysis. Reads all notes and summaries, " +
        "synthesizes the final research brief at files/reports/report.md.",
      tools: ["Write", "Glob", "Read"],
      prompt: prompt("report_writer.txt") + REPORT_WRITER_OVERRIDE,
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
          systemPrompt: prompt("lead_agent.txt") + LEAD_OVERRIDE,
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
