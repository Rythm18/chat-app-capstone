/**
 * Transport hook: owns the session lifecycle and the SSE event stream, and
 * feeds every incoming event through the pure decoder.
 *
 * Separation of concerns:
 *   transport (this file) -> decode (shared/decoder.ts) -> render (components)
 *
 * Reconnection model:
 *  - SSE event ids are the event seq numbers. On transient drops, EventSource
 *    reconnects itself and sends Last-Event-ID, so the server resumes exactly
 *    where we left off (incremental, no reset).
 *  - When WE create a new EventSource (mount, StrictMode remount), we ask for
 *    the full replay and rebuild decoder state from scratch — the stream is
 *    the single source of truth, so replay always converges to the same state.
 *  - Session creation is a module-level singleton so remounts can't create
 *    duplicate server sessions.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { decode, initialChatState, type ChatState } from "../../shared/decoder";
import type { AgentEvent } from "../../shared/events";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export interface Session {
  state: ChatState;
  connection: ConnectionStatus;
  isMock: boolean;
  sendMessage: (text: string) => Promise<void>;
  answerQuestion: (questionId: string, answers: Record<string, string>) => Promise<void>;
  stopRun: () => Promise<void>;
  artifactUrl: (path: string) => string;
}

async function post(url: string, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

let sessionPromise: Promise<{ sessionId: string; mock: boolean }> | null = null;

function getOrCreateSession() {
  sessionPromise ??= post("/api/sessions", {}).then((res) => res.json());
  return sessionPromise;
}

export function useSession(): Session {
  const [state, setState] = useState<ChatState>(initialChatState);
  const stateRef = useRef(state);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [isMock, setIsMock] = useState(false);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;

    getOrCreateSession()
      .then(({ sessionId, mock }) => {
        if (closed) return;
        sessionIdRef.current = sessionId;
        setIsMock(mock);

        // Fresh consumer: rebuild from the stream's full replay.
        stateRef.current = initialChatState;
        setState(initialChatState);

        source = new EventSource(`/api/sessions/${sessionId}/stream`);
        source.onopen = () => setConnection("live");
        source.onerror = () => setConnection("reconnecting");
        source.addEventListener("agent_event", (e: MessageEvent) => {
          stateRef.current = decode(stateRef.current, JSON.parse(e.data) as AgentEvent);
          setState(stateRef.current);
        });
      })
      .catch((err) => {
        console.error("session bootstrap failed:", err);
        setConnection("reconnecting");
      });

    return () => {
      closed = true;
      source?.close();
    };
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const { sessionId } = await getOrCreateSession();
    await post(`/api/sessions/${sessionId}/messages`, { text });
  }, []);

  const answerQuestion = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      const { sessionId } = await getOrCreateSession();
      await post(`/api/sessions/${sessionId}/answers`, { questionId, answers });
    },
    [],
  );

  const stopRun = useCallback(async () => {
    const { sessionId } = await getOrCreateSession();
    await post(`/api/sessions/${sessionId}/interrupt`, {});
  }, []);

  const artifactUrl = useCallback(
    (path: string) =>
      `/api/sessions/${sessionIdRef.current}/artifacts?path=${encodeURIComponent(path)}`,
    [],
  );

  return { state, connection, isMock, sendMessage, answerQuestion, stopRun, artifactUrl };
}
