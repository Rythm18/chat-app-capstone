/**
 * Phase 0 capture: run the (ported) research agent once and record every raw
 * SDK message, hook firing, and canUseTool invocation to a JSONL fixture.
 *
 * The fixture is the design input for our normalized event schema and the
 * test data for the decoder. Run: npx tsx scripts/capture-run.ts
 */
import { query, type AgentDefinition, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS = join(ROOT, "reference/claude-agent-sdk-demos/research-agent/research_agent/prompts");
const FIXTURES = join(ROOT, "fixtures");
const WORKSPACE = join(FIXTURES, "workspace-001");
mkdirSync(join(WORKSPACE, "files"), { recursive: true });

const out = createWriteStream(join(FIXTURES, "run-001.jsonl"), { flags: "w" });
let seq = 0;
function record(channel: string, payload: unknown) {
  out.write(JSON.stringify({ seq: seq++, ts: new Date().toISOString(), channel, payload }) + "\n");
}

const prompt = (f: string) => readFileSync(join(PROMPTS, f), "utf-8").trim();

// Light overrides so the run completes unattended on a bare machine:
// markdown report instead of PDF (no reportlab), tables instead of charts
// (no matplotlib guarantee).
const leadPrompt =
  prompt("lead_agent.txt") +
  "\n\n**IMPORTANT OVERRIDE:** Before dispatching any researchers, you MUST ask the user exactly ONE " +
  "scoping question using the AskUserQuestion tool (e.g. which angle matters most). Use the answer to " +
  "shape the research subtopics. Ask it once, then proceed through the full pipeline without asking again.";

const agents: Record<string, AgentDefinition> = {
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
      "Use AFTER researchers complete. Reads files/research_notes/, extracts metrics and comparisons, " +
      "writes a data summary to files/data/.",
    tools: ["Glob", "Read", "Write"],
    prompt:
      prompt("data_analyst.txt") +
      "\n\n**IMPORTANT OVERRIDE:** Do NOT generate charts or use Bash/Python. Write your quantitative " +
      "analysis as markdown tables in files/data/data_summary.md instead.",
    model: "haiku",
  },
  "report-writer": {
    description:
      "Use LAST. Reads research notes and data summaries, synthesizes the final research brief " +
      "as a markdown document in files/reports/.",
    tools: ["Write", "Glob", "Read"],
    prompt:
      prompt("report_writer.txt") +
      "\n\n**IMPORTANT OVERRIDE:** Produce the final report as a MARKDOWN file in files/reports/report.md. " +
      "Do NOT create a PDF. Do NOT use Bash, reportlab, or any Skill.",
    model: "haiku",
  },
};

const hook =
  (name: string): HookCallback =>
  async (input, toolUseID) => {
    record(`hook:${name}`, { toolUseID, input });
    return {};
  };

const abort = new AbortController();
const killer = setTimeout(() => abort.abort(new Error("capture timeout (15m)")), 15 * 60 * 1000);

async function main() {
  console.log("Starting capture run...");
  record("meta", { note: "capture run start", cwd: WORKSPACE });

  const q = query({
    prompt:
      "Research the current state of the AI agent framework market in 2026. " +
      "Focus on exactly TWO subtopics with one researcher each, run in parallel: " +
      "(1) the Claude Agent SDK, (2) LangChain/LangGraph. Keep research brief — " +
      "2-3 searches per researcher. Then run data-analyst, then report-writer.",
    options: {
      cwd: WORKSPACE,
      model: "sonnet",
      systemPrompt: leadPrompt,
      allowedTools: ["Task", "AskUserQuestion"],
      agents,
      maxTurns: 60,
      abortController: abort,
      includePartialMessages: true,
      forwardSubagentText: true,
      includeHookEvents: true,
      permissionMode: "default",
      hooks: {
        PreToolUse: [{ hooks: [hook("PreToolUse")] }],
        PostToolUse: [{ hooks: [hook("PostToolUse")] }],
        SubagentStart: [{ hooks: [hook("SubagentStart")] }],
        SubagentStop: [{ hooks: [hook("SubagentStop")] }],
      },
      canUseTool: async (toolName, input, opts) => {
        record("canUseTool", { toolName, input, opts: { suggestions: opts?.suggestions } });
        if (toolName === "AskUserQuestion") {
          // Simulate the browser answering after a short pause.
          await new Promise((r) => setTimeout(r, 3000));
          const questions = (input as any).questions ?? [];
          const answers: Record<string, string> = {};
          for (const q of questions) {
            answers[q.question] = q.options?.[0]?.label ?? "your choice";
          }
          record("canUseTool:answer", { toolName, answers });
          return { behavior: "allow", updatedInput: { questions, answers } };
        }
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  for await (const msg of q) {
    record("message", msg);
    const m = msg as any;
    const tag =
      m.type === "assistant" || m.type === "user"
        ? `${m.type}(parent=${m.parent_tool_use_id ?? "-"}, agent=${m.subagent_type ?? "lead"})`
        : `${m.type}${m.subtype ? "/" + m.subtype : ""}`;
    if (m.type !== "stream_event") console.log(`[${seq}] ${tag}`);
  }

  record("meta", { note: "capture run end" });
  console.log("Done. Fixture written to fixtures/run-001.jsonl");
}

main()
  .catch((err) => {
    record("meta", { note: "capture run error", error: String(err) });
    console.error("Capture failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(killer);
    out.end();
  });
