import type { ChatState } from "../../../shared/decoder";
import { latestRun, nodeLabel } from "../../../shared/decoder";

/** Flight-recorder line: what the system is doing right now. */
export function Ticker({ state }: { state: ChatState }) {
  const run = latestRun(state);
  if (!run) return <div className="ticker" />;

  if (run.status === "completed" || run.status === "failed") {
    return (
      <div className="ticker ticker-idle">
        <span className="microlabel">RUN {run.status === "completed" ? "COMPLETE" : "FAILED"}</span>
      </div>
    );
  }

  const t = state.ticker;
  const node = t ? run.nodes[t.agentId] : null;
  const label = node ? nodeLabel(run, node).toUpperCase() : "ORCHESTRATOR";
  const verb =
    t?.kind === "thinking" ? "thinking" :
    t?.kind === "writing" ? "writing" :
    t?.kind === "tool" ? t.detail :
    t?.kind === "spawning" ? `spawning ${t.detail}` :
    t?.kind === "waiting_user" ? "awaiting your input" :
    "working";

  return (
    <div className="ticker ticker-live">
      <span className="ticker-cursor">▮</span>
      <span className="ticker-agent">{label}</span>
      <span className="ticker-sep">▸</span>
      <span className="ticker-verb">{verb}</span>
    </div>
  );
}
