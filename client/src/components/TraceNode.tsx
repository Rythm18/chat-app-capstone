import { useState, type ReactNode } from "react";
import type { AgentNode, Run, Step } from "../../../shared/decoder";
import { nodeLabel } from "../../../shared/decoder";
import { StepView, StreamingText } from "./StepView";
import { StatusDot } from "./StatusDot";
import { elapsed } from "../format";
import { useNow } from "../useNow";

/**
 * Recursive trace rendering.
 *
 * A node's steps render in order; where a child agent was spawned, the child
 * appears inline at that chronological position. Children whose lifetimes
 * overlapped are grouped into a "wave" and rendered side-by-side under a
 * ∥ PARALLEL badge — the grouping is computed from start/end timestamps, so
 * it remains visible after the run completes (history keeps its shape).
 */
export function TraceNodeBody({
  run,
  node,
  depth,
}: {
  run: Run;
  node: AgentNode;
  depth: number;
}) {
  const rendered = new Set<string>();
  const blocks: ReactNode[] = [];

  node.steps.forEach((step, i) => {
    if (step.kind !== "child") {
      blocks.push(<StepView key={i} step={step} />);
      return;
    }
    if (rendered.has(step.nodeId)) return;
    const wave = waveFor(run, node, step.nodeId, rendered);
    blocks.push(
      <div key={i} className={`wave ${wave.length > 1 ? "wave-parallel" : ""}`}>
        {wave.length > 1 && (
          <span className="parallel-badge">∥ PARALLEL ×{wave.length}</span>
        )}
        <div className="wave-items" style={wave.length > 1 ? { gridTemplateColumns: `repeat(${Math.min(wave.length, 3)}, 1fr)` } : undefined}>
          {wave.map((id) => (
            <TraceNodeCard key={id} run={run} node={run.nodes[id]} depth={depth + 1} />
          ))}
        </div>
      </div>,
    );
  });

  if (node.streaming) blocks.push(<StreamingText key="streaming" streaming={node.streaming} />);

  return <div className="node-steps">{blocks}</div>;
}

/** Children overlapping the seed child's lifetime form one parallel wave. */
function waveFor(run: Run, parent: AgentNode, seedId: string, rendered: Set<string>): string[] {
  const wave: string[] = [];
  for (const id of parent.children) {
    if (rendered.has(id)) continue;
    const candidate = run.nodes[id];
    if (!candidate) continue;
    if (id === seedId || wave.some((wid) => overlaps(run.nodes[wid], candidate))) {
      wave.push(id);
      rendered.add(id);
    }
  }
  return wave;
}

function overlaps(a: AgentNode | undefined, b: AgentNode): boolean {
  if (!a) return false;
  const aStart = a.startedTs ? Date.parse(a.startedTs) : Infinity;
  const bStart = b.startedTs ? Date.parse(b.startedTs) : Infinity;
  const aEnd = a.endedTs ? Date.parse(a.endedTs) : Infinity;
  const bEnd = b.endedTs ? Date.parse(b.endedTs) : Infinity;
  return aStart < bEnd && bStart < aEnd;
}

/** One sub-agent card: status rail + header; expands to its steps (and its
 *  own children, recursively). Completed nodes auto-collapse to a summary —
 *  click to reopen. */
function TraceNodeCard({ run, node, depth }: { run: Run; node: AgentNode; depth: number }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const nodeActive = node.status === "running" || node.status === "awaiting_input";
  const now = useNow(nodeActive);
  const open = override ?? nodeActive;

  const toolCount = node.steps.filter((s) => s.kind === "tool").length;

  return (
    <div className={`node-card node-${node.status}`}>
      <button className="node-head" onClick={() => setOverride(!open)}>
        <span className={`chevron ${open ? "chevron-open" : ""}`}>▸</span>
        <StatusDot status={node.status} />
        <span className="node-label">{nodeLabel(run, node)}</span>
        {node.description && <span className="node-desc">{node.description}</span>}
        <span className="node-meta">
          {node.status === "queued"
            ? "queued"
            : `${toolCount > 0 ? `${toolCount} tools · ` : ""}${elapsed(node.startedTs, node.endedTs, now)}`}
        </span>
      </button>
      {open && (
        <div className="node-body">
          {node.prompt && (
            <details className="node-prompt">
              <summary className="microlabel">TASK PROMPT</summary>
              <pre>{node.prompt}</pre>
            </details>
          )}
          <TraceNodeBody run={run} node={node} depth={depth} />
          {node.resultText && node.status !== "running" && (
            <div className="node-result">
              <span className="microlabel">REPORTED BACK</span>
              <pre>{node.resultText}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
