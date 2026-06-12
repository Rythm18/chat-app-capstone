/** Sanity check: run the recorded fixture through the Normalizer and print
 *  the event histogram, per-node routing, and tree shape. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Normalizer } from "../server/normalize.js";
import type { AgentEventBody } from "../shared/events.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = readFileSync(join(ROOT, "fixtures/run-001.jsonl"), "utf-8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const n = new Normalizer();
const out: AgentEventBody[] = [];
for (const e of entries) if (e.channel === "message") out.push(...n.handle(e.payload));

const counts: Record<string, number> = {};
for (const ev of out) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
console.log("normalized events:", out.length);
console.log(counts);

const perNode: Record<string, number> = {};
for (const ev of out) perNode[ev.agentId.slice(-8)] = (perNode[ev.agentId.slice(-8)] ?? 0) + 1;
console.log("events per node:", perNode);

for (const ev of out) {
  if (ev.type === "agent_start")
    console.log(`agent_start: ${ev.agentType} child=${ev.childId.slice(-8)} under=${ev.agentId}`);
  if (ev.type === "agent_end") console.log(`agent_end:   ${ev.agentId.slice(-8)} ${ev.status}`);
  if (ev.type === "artifact") console.log(`artifact:    ${ev.path} by=${ev.agentId.slice(-8)}`);
}
