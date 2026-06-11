/** Minimal capture: one trivial query to record system/init -> assistant -> result shapes. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(ROOT, "fixtures"), { recursive: true });
const out = createWriteStream(join(ROOT, "fixtures/run-002-mini.jsonl"), { flags: "w" });
let seq = 0;

const q = query({
  prompt: "Reply with exactly one short sentence: what is a research agent?",
  options: {
    model: "haiku",
    maxTurns: 2,
    allowedTools: [],
    includePartialMessages: true,
  },
});

for await (const msg of q) {
  out.write(JSON.stringify({ seq: seq++, ts: new Date().toISOString(), channel: "message", payload: msg }) + "\n");
  const m = msg as any;
  if (m.type !== "stream_event") console.log(`[${seq}] ${m.type}${m.subtype ? "/" + m.subtype : ""}`);
}
out.end();
console.log("mini capture done");
