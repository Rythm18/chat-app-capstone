/**
 * Session persistence: the event log IS the application state, so durability
 * is "append every emitted event to disk, replay the log on boot."
 *
 * Layout (one pair of files per session, under a data directory):
 *   <id>.meta.json   { id, workspaceDir, mock, createdAt }
 *   <id>.jsonl       one normalized AgentEvent per line, in emit order
 *
 * Events are appended synchronously (appendFileSync). At a few hundred tiny
 * lines per run this is immaterial, and flushing each event immediately means
 * a crash loses nothing already shown to the user.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../shared/events.js";

export interface SessionMeta {
  id: string;
  workspaceDir: string;
  mock: boolean;
  createdAt: string;
}

/** Append-only log for one session. Writing the meta file is idempotent, so
 *  reopening an existing session's log on restore is safe. */
export class SessionLog {
  private eventsPath: string;

  constructor(dir: string, meta: SessionMeta) {
    mkdirSync(dir, { recursive: true });
    this.eventsPath = join(dir, `${meta.id}.jsonl`);
    writeFileSync(join(dir, `${meta.id}.meta.json`), JSON.stringify(meta, null, 2));
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "");
  }

  append(event: AgentEvent) {
    appendFileSync(this.eventsPath, JSON.stringify(event) + "\n");
  }
}

/** Read every persisted session back from disk. Corrupt lines are skipped
 *  rather than failing the whole boot. */
export function loadPersistedSessions(
  dir: string,
): Array<{ meta: SessionMeta; events: AgentEvent[] }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ meta: SessionMeta; events: AgentEvent[] }> = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".meta.json")) continue;
    let meta: SessionMeta;
    try {
      meta = JSON.parse(readFileSync(join(dir, file), "utf-8")) as SessionMeta;
    } catch {
      continue;
    }
    const eventsPath = join(dir, `${meta.id}.jsonl`);
    const events: AgentEvent[] = [];
    if (existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as AgentEvent);
        } catch {
          /* skip a torn final line from an abrupt shutdown */
        }
      }
    }
    out.push({ meta, events });
  }
  return out;
}
