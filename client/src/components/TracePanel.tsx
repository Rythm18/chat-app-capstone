import { useState } from "react";
import type { Run } from "../../../shared/decoder";
import type { Session } from "../useSession";
import { TraceNodeBody } from "./TraceNode";
import { StatusDot } from "./StatusDot";
import { elapsed } from "../format";

/**
 * Right pane: one trace section per run (multi-run stacking). Older runs
 * collapse to a summary line; the active run is always open.
 */
export function TracePanel({ session }: { session: Session }) {
  const { state } = session;

  return (
    <section className="trace-pane">
      <div className="trace-head microlabel">EXECUTION TRACE</div>
      <div className="trace-scroll">
        {state.runs.length === 0 && (
          <div className="trace-empty">
            <span className="microlabel">NO RUNS YET</span>
            <p>Agent activity will appear here the moment you send a message.</p>
          </div>
        )}
        {state.runs.map((run, i) => (
          <RunTrace key={run.runId} run={run} index={i} isLatest={i === state.runs.length - 1} />
        ))}
      </div>
    </section>
  );
}

function RunTrace({ run, index, isLatest }: { run: Run; index: number; isLatest: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? isLatest; // older runs auto-collapse
  const root = run.nodes["root"];
  const agentCount = Object.keys(run.nodes).length - 1;

  return (
    <div className={`run-trace run-trace-${run.status}`}>
      <button className="run-trace-head" onClick={() => setOverride(!open)}>
        <span className={`chevron ${open ? "chevron-open" : ""}`}>▸</span>
        <StatusDot
          status={
            run.status === "completed" ? "completed" :
            run.status === "failed" ? "failed" :
            run.status === "awaiting_input" ? "awaiting_input" : "running"
          }
        />
        <span className="run-trace-title">
          RUN {String(index + 1).padStart(2, "0")} · {run.userMessage || "(continued)"}
        </span>
        <span className="run-trace-meta">
          {agentCount > 0 ? `${agentCount} agents · ` : ""}
          {elapsed(run.startedTs, run.status === "completed" || run.status === "failed" ? lastEnd(run) : null)}
        </span>
      </button>
      {open && root && (
        <div className="run-trace-body">
          <TraceNodeBody run={run} node={root} depth={0} />
        </div>
      )}
    </div>
  );
}

function lastEnd(run: Run): string | null {
  let last: string | null = null;
  for (const node of Object.values(run.nodes)) {
    if (node.endedTs && (!last || node.endedTs > last)) last = node.endedTs;
  }
  return last;
}
