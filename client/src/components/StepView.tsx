import { useState } from "react";
import type { Step, AgentNode } from "../../../shared/decoder";
import { Markdown } from "./Markdown";
import { toolInputSummary } from "../format";

/** Renders a single non-child step inside a trace node. */
export function StepView({ step }: { step: Step }) {
  switch (step.kind) {
    case "thinking":
      return (
        <div className="step step-thinking">
          <span className="microlabel">≋ THINKING</span>
          <p>{step.text}</p>
        </div>
      );
    case "response":
      return (
        <div className="step step-response">
          <Markdown text={step.text} />
        </div>
      );
    case "tool":
      return <ToolStepRow step={step} />;
    case "ask_user":
      return (
        <div className="step step-ask">
          <span className="microlabel">
            ? ASKED USER {step.status === "pending" ? "· AWAITING ANSWER" : ""}
          </span>
          {step.questions.map((q) => (
            <p key={q.question}>
              {q.question}
              {step.answers?.[q.question] && (
                <span className="ask-answer"> → {step.answers[q.question]}</span>
              )}
            </p>
          ))}
        </div>
      );
    case "child":
      return null; // rendered by TraceNodeBody as a (possibly parallel) wave
  }
}

function ToolStepRow({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const glyph = step.status === "running" ? "◌" : step.status === "ok" ? "✓" : "✗";

  return (
    <div className={`step step-tool step-tool-${step.status}`}>
      <button className="tool-row" onClick={() => setOpen(!open)}>
        <span className={`tool-glyph tool-glyph-${step.status}`}>{glyph}</span>
        <span className="tool-name">{step.tool}</span>
        <span className="tool-summary">{toolInputSummary(step.tool, step.input)}</span>
        {step.status === "running" && step.elapsedSeconds !== null && (
          <span className="tool-elapsed">{Math.round(step.elapsedSeconds)}s</span>
        )}
      </button>
      {open && (
        <div className="tool-detail">
          <span className="microlabel">INPUT</span>
          <pre>{JSON.stringify(step.input, null, 2)}</pre>
          {step.output !== null && (
            <>
              <span className="microlabel">
                OUTPUT{step.outputTruncated ? " (TRUNCATED)" : ""}
              </span>
              <pre>{step.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Live streaming buffer with a blinking caret — supersedes itself when the
 *  completed block arrives. */
export function StreamingText({ streaming }: { streaming: NonNullable<AgentNode["streaming"]> }) {
  return (
    <div className={`step step-streaming ${streaming.blockType === "thinking" ? "step-thinking" : ""}`}>
      {streaming.blockType === "thinking" && <span className="microlabel">≋ THINKING</span>}
      <p>
        {streaming.text}
        <span className="caret">▮</span>
      </p>
    </div>
  );
}
