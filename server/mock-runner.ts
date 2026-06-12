/**
 * MockAgentRunner: replays a recorded fixture (fixtures/run-001.jsonl, the
 * raw messages of a real SDK run) through the same Normalizer the live
 * runner uses. Development mode only — costs nothing, is deterministic, and
 * exercises every code path including the interactive ask_user pause: the
 * replay genuinely blocks until the browser answers.
 *
 * Inter-event delays mimic the recording's rhythm, clamped so a replay takes
 * seconds rather than the original minutes (MOCK_SPEED env scales it).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Normalizer, parseAskUserQuestions } from "./normalize.js";
import type { ChatSession, AgentRunner } from "./sessions.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = join(ROOT, "fixtures", "run-001.jsonl");
/** Workspace the fixture run actually wrote its artifacts into. */
export const MOCK_WORKSPACE = join(ROOT, "fixtures", "workspace-001");

const MAX_GAP_MS = 350;
const SPEED = Number(process.env.MOCK_SPEED ?? "1");

interface FixtureEntry {
  seq: number;
  ts: string;
  channel: string;
  payload: any;
}

export class MockAgentRunner implements AgentRunner {
  private entries: FixtureEntry[];
  private replaying = false;
  private closed = false;

  constructor(private session: ChatSession) {
    this.entries = readFileSync(FIXTURE_PATH, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  send(_text: string) {
    // The user's text is ignored — the recording researched what it
    // researched. Each message triggers one full replay.
    if (this.replaying) return;
    this.replaying = true;
    void this.replay().finally(() => (this.replaying = false));
  }

  /** Stop the replay; the session's interrupt fallback finalizes the run. */
  interrupt() {
    this.closed = true;
  }

  close() {
    this.closed = true;
  }

  private async replay() {
    const session = this.session;
    const normalizer = new Normalizer(session.workspaceDir);
    let lastTs: number | null = null;
    let lastRootResponse = "";
    let sawDone = false;

    for (const entry of this.entries) {
      if (this.closed) return;

      // Pace the replay like the original run, compressed.
      const ts = Date.parse(entry.ts);
      if (lastTs !== null) {
        const gap = Math.min(Math.max(ts - lastTs, 0), MAX_GAP_MS) / SPEED;
        if (gap > 5) await new Promise((r) => setTimeout(r, gap));
      }
      lastTs = ts;

      if (entry.channel === "message") {
        for (const body of normalizer.handle(entry.payload)) {
          if (body.type === "response" && body.agentId === "root") {
            lastRootResponse = body.text;
          }
          if (body.type === "done") sawDone = true;
          session.emit(body);
        }
      } else if (
        entry.channel === "canUseTool" &&
        entry.payload.toolName === "AskUserQuestion"
      ) {
        // Real interactive pause: block the replay until the browser answers,
        // exactly like the live runner blocks inside canUseTool.
        const questions = parseAskUserQuestions(entry.payload.input);
        await session.askUser("root", questions);
      }
      // hook:* / canUseTool:answer / meta channels: capture-time diagnostics,
      // nothing to render.
    }

    // Safety net for truncated fixtures: if the recording lacks a final
    // `result` message, synthesize the `done` so every replayed run
    // terminates cleanly. (run-001 is complete, so this normally won't fire.)
    if (!sawDone) {
      session.emit({
        type: "done",
        agentId: "root",
        status: "success",
        resultText:
          lastRootResponse ||
          "Research complete. See the generated artifacts for the full findings.",
        durationMs: 0,
        numTurns: 0,
        costUsd: null,
      });
    }
  }
}
