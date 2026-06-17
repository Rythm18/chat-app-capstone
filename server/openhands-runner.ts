/**
 * OpenHandsRunner: drives the OpenHands engine via a Python sidecar.
 *
 * OpenHands ships only a Python SDK, so the agent loop runs in a child
 * process (agent/openhands_runner.py) and we exchange JSON lines over stdio —
 * the same boundary the Claude SDK uses internally. This keeps the entire
 * Node backend, decoder, UI, and tests engine-agnostic: the sidecar emits the
 * SAME normalized AgentEventBody objects (shared/events.ts) that the Claude
 * normalizer produces, so everything downstream is unchanged.
 *
 * Unlike the Claude/mock runners, the ask_user pause lives in the Python
 * process (its ask_user tool blocks there), so answers are forwarded to the
 * child's stdin via answer() rather than resolving a Node-side promise.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatSession, AgentRunner } from "./sessions.js";
import type { AgentEventBody } from "../shared/events.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = join(ROOT, "agent", ".venv", "bin", "python");
const SCRIPT = join(ROOT, "agent", "openhands_runner.py");

export class OpenHandsRunner implements AgentRunner {
  private proc: ChildProcessWithoutNullStreams;
  private rl: Interface;
  private closed = false;

  constructor(private session: ChatSession) {
    const args = [SCRIPT];
    if (process.env.OPENHANDS_SELFTEST === "1") args.push("--selftest");

    this.proc = spawn(PYTHON, args, {
      cwd: session.workspaceDir, // agent file writes land in the session workspace
      env: process.env, // LLM_API_KEY / LLM_BASE_URL / LLM_MODEL from .env
    });

    // stdout: one normalized AgentEventBody per line -> straight into the session
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let body: AgentEventBody;
      try {
        body = JSON.parse(text) as AgentEventBody;
      } catch {
        console.error("[openhands] non-JSON line:", text.slice(0, 200));
        return;
      }
      this.session.emit(body);
    });

    // stderr is the sidecar's diagnostics (SDK banner, tracebacks) — log, don't emit
    this.proc.stderr.on("data", (d) => process.stderr.write(`[openhands] ${d}`));

    this.proc.on("error", (err) => {
      this.session.emit({
        type: "error",
        agentId: "root",
        message: `failed to start OpenHands sidecar: ${err.message}`,
        source: "server",
      });
    });

    this.proc.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.session.emit({
          type: "error",
          agentId: "root",
          message: `OpenHands sidecar exited with code ${code}`,
          source: "server",
        });
      }
    });
  }

  private write(msg: Record<string, unknown>) {
    if (this.closed || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  send(text: string) {
    this.write({ type: "user_message", text });
  }

  /** Forward an ask_user answer to the child, where the pause is blocking. */
  answer(questionId: string, answers: Record<string, string>) {
    this.write({ type: "answer", questionId, answers });
  }

  interrupt() {
    this.write({ type: "interrupt" });
  }

  close() {
    this.closed = true;
    this.rl.close();
    this.proc.stdin.end();
    this.proc.kill();
  }
}
