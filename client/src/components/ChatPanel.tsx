import { useEffect, useRef, useState } from "react";
import type { Run } from "../../../shared/decoder";
import { nodeLabel } from "../../../shared/decoder";
import type { Session } from "../useSession";
import { Markdown } from "./Markdown";
import { AskUserCard } from "./AskUserCard";
import { ArtifactChips, ReportPanel } from "./Artifacts";
import { StatusDot } from "./StatusDot";
import { elapsed } from "../format";
import { useNow } from "../useNow";

const SAMPLE_PROMPTS = [
  "Research the AI agent framework market in 2026",
  "Research Anthropic's competitive position in enterprise AI",
  "Research the current state of solid-state battery technology",
];

export function ChatPanel({ session }: { session: Session }) {
  const { state, sendMessage } = session;
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the conversation as events stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state]);

  const busy = state.runs.some((r) => r.status === "running" || r.status === "awaiting_input");

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    void sendMessage(trimmed);
  };

  // Grow the composer with its content, up to a cap.
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  return (
    <section className="chat-pane">
      <div className="chat-scroll" ref={scrollRef}>
        {state.runs.length === 0 ? (
          <EmptyState onPick={submit} />
        ) : (
          state.runs.map((run) => <RunBlock key={run.runId} run={run} session={session} />)
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <span className="composer-prompt">›</span>
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            autosize(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(draft);
            }
          }}
          placeholder={busy ? "run in progress…" : "what should we research?"}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          SEND
        </button>
      </form>
    </section>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">◆</div>
      <h1>Deep Analyst</h1>
      <p>
        A research team of AI agents — with the engine cover off. Ask a question and watch the
        orchestrator decompose it, dispatch parallel researchers, and synthesize a brief.
      </p>
      <div className="empty-samples">
        {SAMPLE_PROMPTS.map((p) => (
          <button key={p} onClick={() => onPick(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function RunBlock({ run, session }: { run: Run; session: Session }) {
  const { state, answerQuestion } = session;
  const pending =
    state.pendingQuestion && state.pendingQuestion.runId === run.runId
      ? state.pendingQuestion
      : null;

  return (
    <div className="run-block">
      <div className="user-msg">
        <span className="user-msg-prompt">›</span>
        {run.userMessage || "(continued)"}
      </div>

      <RunStatusCard run={run} onStop={() => void session.stopRun()} />

      {pending && (
        <AskUserCard
          key={pending.questionId}
          question={pending}
          onAnswer={(answers) => void answerQuestion(pending.questionId, answers)}
        />
      )}

      {run.errors.length > 0 && (
        <div className="error-card">
          <span className="microlabel">ERRORS</span>
          {run.errors.map((e, i) => (
            <div key={i} className="error-line">
              <span className="error-source">[{e.source}]</span> {e.message}
            </div>
          ))}
        </div>
      )}

      {run.status === "completed" && run.resultText && (
        <div className="result-card">
          <div className="result-head">
            <span className="microlabel">RESEARCH BRIEF</span>
            <span className="microlabel result-meta">
              {run.durationMs ? `${Math.round(run.durationMs / 1000)}s` : ""}
              {run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ""}
            </span>
          </div>
          <Markdown text={run.resultText} />
          <ReportPanel run={run} session={session} />
          <ArtifactChips run={run} session={session} />
        </div>
      )}
      {run.status === "failed" && (
        <div className="result-card result-failed">
          <span className="microlabel">RUN FAILED</span>
          {run.resultText && <Markdown text={run.resultText} />}
        </div>
      )}
    </div>
  );
}

/** Live status card — the chat never looks idle while a run is in flight. */
function RunStatusCard({ run, onStop }: { run: Run; onStop: () => void }) {
  const active = run.status === "running" || run.status === "awaiting_input";
  const now = useNow(active);
  const [stopping, setStopping] = useState(false);
  if (!active) return null;
  const agents = Object.values(run.nodes).filter((n) => n.id !== "root");
  const running = agents.filter((n) => n.status === "running").length;

  return (
    <div className="run-status-card">
      <div className="run-status-head">
        <StatusDot status={run.status === "awaiting_input" ? "awaiting_input" : "running"} />
        <span className="run-status-label">
          {run.status === "awaiting_input" ? "PAUSED — INPUT REQUESTED" : "RUN IN PROGRESS"}
        </span>
        <span className="run-status-elapsed">{elapsed(run.startedTs, null, now)}</span>
        <button
          className="stop-btn"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            onStop();
          }}
          title="Stop this run"
        >
          ■ {stopping ? "STOPPING…" : "STOP"}
        </button>
      </div>
      {agents.length > 0 && (
        <div className="run-status-agents">
          {agents.map((n) => (
            <span key={n.id} className={`agent-pill agent-pill-${n.status}`}>
              <StatusDot status={n.status} />
              {nodeLabel(run, n)}
            </span>
          ))}
          {running > 1 && <span className="parallel-flag">∥ {running} in parallel</span>}
        </div>
      )}
    </div>
  );
}
