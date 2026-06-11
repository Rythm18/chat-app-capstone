import { useState } from "react";
import type { PendingQuestion } from "../../../shared/decoder";

/**
 * Interactive ask_user card. Single-select questions answer on click;
 * multi-select collects toggles behind a confirm button; every question also
 * accepts a free-text answer. Multiple questions submit together once each
 * has an answer.
 */
export function AskUserCard({
  question,
  onAnswer,
}: {
  question: PendingQuestion;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const answerFor = (q: string): string | null => {
    const free = freeText[q]?.trim();
    if (free) return free;
    const labels = picked[q] ?? [];
    return labels.length > 0 ? labels.join(", ") : null;
  };
  const complete = question.questions.every((q) => answerFor(q.question) !== null);

  const submit = () => {
    if (!complete || submitted) return;
    setSubmitted(true);
    const answers: Record<string, string> = {};
    for (const q of question.questions) answers[q.question] = answerFor(q.question)!;
    onAnswer(answers);
  };

  // Single question, single select, no free text typed -> answer immediately on click.
  const instant =
    question.questions.length === 1 && !question.questions[0].multiSelect;

  return (
    <div className="ask-card">
      <div className="ask-head">
        <span className="ask-pulse" />
        <span className="microlabel">AGENT REQUESTS INPUT</span>
      </div>
      {question.questions.map((q) => (
        <div key={q.question} className="ask-question">
          {q.header && <span className="ask-header-chip">{q.header}</span>}
          <p className="ask-text">{q.question}</p>
          <div className="ask-options">
            {q.options.map((opt) => {
              const selected = (picked[q.question] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  disabled={submitted}
                  className={`ask-option ${selected ? "ask-option-selected" : ""}`}
                  title={opt.description}
                  onClick={() => {
                    if (instant) {
                      setPicked({ [q.question]: [opt.label] });
                      setSubmitted(true);
                      onAnswer({ [q.question]: opt.label });
                      return;
                    }
                    setPicked((prev) => {
                      const cur = prev[q.question] ?? [];
                      const next = q.multiSelect
                        ? selected
                          ? cur.filter((l) => l !== opt.label)
                          : [...cur, opt.label]
                        : [opt.label];
                      return { ...prev, [q.question]: next };
                    });
                  }}
                >
                  <span className="ask-option-label">{opt.label}</span>
                  {opt.description && <span className="ask-option-desc">{opt.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            className="ask-freetext"
            placeholder="or type your own answer…"
            disabled={submitted}
            value={freeText[q.question] ?? ""}
            onChange={(e) =>
              setFreeText((prev) => ({ ...prev, [q.question]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
      ))}
      {!instant && (
        <button className="ask-submit" disabled={!complete || submitted} onClick={submit}>
          {submitted ? "SENT" : "ANSWER"}
        </button>
      )}
    </div>
  );
}
