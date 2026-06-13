/**
 * HTTP layer.
 *
 *   POST /api/sessions                    create a chat session -> {sessionId}
 *   GET  /api/sessions/:id/stream         SSE event stream (resumable via Last-Event-ID)
 *   POST /api/sessions/:id/messages       send a user message {text}
 *   POST /api/sessions/:id/answers        answer an ask_user {questionId, answers}
 *   GET  /api/sessions/:id/artifacts      read an artifact {?path=files/...}
 *
 * Mock mode (no API spend, replays a recorded run): MOCK=1 npm run dev,
 * or per-session with POST /api/sessions {"mock": true}.
 */
import express from "express";
import cors from "cors";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatSession, SessionStore } from "./sessions.js";
import { SdkAgentRunner } from "./agent-runner.js";
import { MockAgentRunner, MOCK_WORKSPACE } from "./mock-runner.js";
import { SessionLog, loadPersistedSessions } from "./persistence.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const PORT = Number(process.env.PORT ?? 3001);
const MOCK_DEFAULT = process.env.MOCK === "1";

const app = express();
app.use(cors());
app.use(express.json());

const store = new SessionStore();

function attachRunnerFor(session: ChatSession) {
  session.attachRunner(
    session.mock ? new MockAgentRunner(session) : new SdkAgentRunner(session),
  );
}

/** Create a fresh persisted session with a live runner attached. */
function createSession(mock: boolean): ChatSession {
  const workspaceDir = mock ? MOCK_WORKSPACE : join(ROOT, "runs", `session-${Date.now()}`);
  if (!mock) mkdirSync(join(workspaceDir, "files"), { recursive: true });
  const session = new ChatSession(workspaceDir, { mock });
  const log = new SessionLog(DATA_DIR, {
    id: session.id,
    workspaceDir,
    mock,
    createdAt: new Date().toISOString(),
  });
  session.setPersist((e) => log.append(e));
  attachRunnerFor(session);
  store.add(session);
  return session;
}

// Restore persisted sessions on boot. Event history is rehydrated and any
// run that was mid-flight at shutdown is finalized as interrupted. Runners
// are attached lazily (on resume) so boot doesn't spawn idle SDK children.
let restored = 0;
for (const { meta, events } of loadPersistedSessions(DATA_DIR)) {
  const session = new ChatSession(meta.workspaceDir, { id: meta.id, mock: meta.mock });
  const log = new SessionLog(DATA_DIR, meta);
  session.setPersist((e) => log.append(e));
  session.hydrate(events);
  session.finalizeInterruptedRuns();
  store.add(session);
  restored++;
}

app.post("/api/sessions", (req, res) => {
  // Resume an existing session (page reload, or after a server restart).
  const resumeId = typeof req.body?.resume === "string" ? req.body.resume : null;
  if (resumeId) {
    const existing = store.get(resumeId);
    if (existing) {
      if (!existing.hasRunner()) attachRunnerFor(existing); // wake a restored session
      return res.json({ sessionId: existing.id, mock: existing.mock, resumed: true });
    }
  }
  const mock = typeof req.body?.mock === "boolean" ? req.body.mock : MOCK_DEFAULT;
  const session = createSession(mock);
  res.json({ sessionId: session.id, mock, resumed: false });
});

app.get("/api/sessions/:id/stream", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "unknown session" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const lastEventIdRaw =
    req.headers["last-event-id"] ?? (req.query.lastEventId as string | undefined);
  const lastEventId =
    lastEventIdRaw !== undefined && lastEventIdRaw !== "" ? Number(lastEventIdRaw) : null;
  session.subscribe(res, Number.isFinite(lastEventId) ? lastEventId : null);
});

app.post("/api/sessions/:id/messages", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "unknown session" });
  const text = req.body?.text;
  if (typeof text !== "string" || text.trim() === "") {
    return res.status(400).json({ error: "text required" });
  }
  session.sendUserMessage(text.trim());
  res.json({ ok: true });
});

app.post("/api/sessions/:id/interrupt", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "unknown session" });
  session.interrupt();
  res.json({ ok: true });
});

app.post("/api/sessions/:id/answers", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "unknown session" });
  const { questionId, answers } = req.body ?? {};
  if (typeof questionId !== "string" || typeof answers !== "object" || answers === null) {
    return res.status(400).json({ error: "questionId and answers required" });
  }
  const ok = session.answerQuestion(questionId, answers);
  if (!ok) return res.status(404).json({ error: "unknown or already-answered question" });
  res.json({ ok: true });
});

app.get("/api/sessions/:id/artifacts", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "unknown session" });
  const relPath = req.query.path;
  if (typeof relPath !== "string") return res.status(400).json({ error: "path required" });

  // Artifacts are only ever served from inside this session's workspace.
  const workspace = resolve(session.workspaceDir);
  const full = resolve(workspace, relPath);
  if (!full.startsWith(workspace + "/")) {
    return res.status(403).json({ error: "path outside session workspace" });
  }
  if (!existsSync(full)) return res.status(404).json({ error: "artifact not found" });
  res.type("text/plain").send(readFileSync(full, "utf-8"));
});

app.listen(PORT, () => {
  console.log(
    `agent-chat server on http://localhost:${PORT} ` +
      `(default mode: ${MOCK_DEFAULT ? "MOCK replay" : "LIVE SDK"}` +
      `${restored ? `, restored ${restored} session${restored === 1 ? "" : "s"}` : ""})`,
  );
});
