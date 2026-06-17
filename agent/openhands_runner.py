#!/usr/bin/env python3
"""
OpenHands sidecar runner.

The Node backend spawns this script as a child process and speaks a small
JSON-lines protocol over stdio — the same shape the Claude Agent SDK uses
internally (a child process exchanging JSON), so the Node side stays an
engine-agnostic pipe.

PROTOCOL
  stdin  (Node -> here), one JSON object per line:
    {"type": "user_message", "text": "..."}
    {"type": "answer", "questionId": "...", "answers": {"<q>": "<label>"}}
    {"type": "interrupt"}
  stdout (here -> Node), one JSON object per line — each is a normalized
    AgentEventBody exactly as defined in shared/events.ts (NO envelope; the
    Node session stamps seq/runId/ts). e.g.:
    {"type": "session_init", "agentId": "root", "sessionId": "...", "model": "...", "agentTypes": [...]}
    {"type": "agent_start", "agentId": "root", "childId": "researcher-1", ...}

MODES
  --selftest : emit a scripted multi-agent run (no LLM, no network). Proves the
               whole pipe end-to-end and exercises every normalized event type,
               including a real ask_user pause that blocks for a stdin answer.
  (default)  : run the live OpenHands pipeline — wired in once the OpenHands
               model credentials authenticate (see emit_live()).
"""
import sys
import json
import threading
import time
import argparse
from typing import Any


# --- stdout: thread-safe, line-buffered emit of normalized event bodies -----
_emit_lock = threading.Lock()


def emit(body: dict[str, Any]) -> None:
    """Write one normalized AgentEventBody as a JSON line. Thread-safe so
    parallel sub-agents (separate threads) can't interleave a line."""
    line = json.dumps(body, ensure_ascii=False)
    with _emit_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# --- stdin: a background reader dispatches inbound messages -----------------
class Inbox:
    """Parses stdin JSON lines into queues the run logic waits on."""

    def __init__(self) -> None:
        self._messages: list[str] = []
        self._answers: dict[str, dict[str, str]] = {}
        self._cv = threading.Condition()
        self._interrupted = False
        self._closed = False

    def start(self) -> None:
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self) -> None:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            with self._cv:
                kind = msg.get("type")
                if kind == "user_message":
                    self._messages.append(msg.get("text", ""))
                elif kind == "answer":
                    self._answers[msg.get("questionId", "")] = msg.get("answers", {})
                elif kind == "interrupt":
                    self._interrupted = True
                self._cv.notify_all()
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def next_message(self) -> str | None:
        with self._cv:
            while not self._messages and not self._closed:
                self._cv.wait()
            return self._messages.pop(0) if self._messages else None

    def wait_for_answer(self, question_id: str) -> dict[str, str]:
        with self._cv:
            while question_id not in self._answers and not self._interrupted:
                self._cv.wait()
            return self._answers.pop(question_id, {})

    @property
    def interrupted(self) -> bool:
        with self._cv:
            return self._interrupted


# --- self-test: a scripted run that drives the whole pipe without an LLM ----
def run_selftest(inbox: Inbox) -> None:
    """Emit a faithful multi-agent sequence so the Node->SSE->decoder->UI pipe
    can be validated with zero model dependency. Mirrors the real flow:
    init -> scoping question -> 2 parallel researchers -> analyst -> writer -> done."""
    text = inbox.next_message()
    if text is None:
        return

    emit({
        "type": "session_init",
        "agentId": "root",
        "sessionId": "selftest-session",
        "model": "openhands/selftest",
        "agentTypes": ["researcher", "data-analyst", "report-writer"],
    })
    time.sleep(0.2)
    emit({"type": "thinking", "agentId": "root",
          "text": f'Scoping "{text}" before dispatching researchers.'})

    # ask_user: block until the browser answers (real pause/resume over stdio)
    qid = "selftest-q1"
    emit({
        "type": "ask_user", "agentId": "root", "questionId": qid,
        "questions": [{
            "question": "Which angle matters most for your research?",
            "header": "Focus area", "multiSelect": False,
            "options": [
                {"label": "Technical capabilities", "description": "Architecture, APIs, features"},
                {"label": "Market adoption", "description": "Usage, traction, ecosystem"},
            ],
        }],
    })
    answers = inbox.wait_for_answer(qid)
    if inbox.interrupted:
        return
    chosen = next(iter(answers.values()), "Technical capabilities")
    # Node emits ask_user_answered uniformly across engines; we just resume.
    emit({"type": "response", "agentId": "root",
          "text": f"Focusing on {chosen}. Spawning 2 researchers in parallel."})

    # two researchers, dispatched then run concurrently
    researchers = [
        ("researcher-1", "Subtopic A research"),
        ("researcher-2", "Subtopic B research"),
    ]
    for cid, desc in researchers:
        emit({"type": "agent_queued", "agentId": "root", "childId": cid,
              "agentType": "researcher", "description": desc, "prompt": f"Research: {desc}"})

    def run_researcher(cid: str, desc: str, query: str, note: str) -> None:
        emit({"type": "agent_start", "agentId": "root", "childId": cid,
              "agentType": "researcher", "description": desc, "prompt": f"Research: {desc}"})
        tool_id = f"{cid}-search"
        emit({"type": "tool_start", "agentId": cid, "toolUseId": tool_id,
              "tool": "WebSearch", "input": {"query": query}})
        time.sleep(0.4)
        emit({"type": "tool_end", "agentId": cid, "toolUseId": tool_id,
              "tool": "WebSearch", "output": f"Results for {query}", "outputTruncated": False, "isError": False})
        write_id = f"{cid}-write"
        path = f"files/research_notes/{cid}.md"
        emit({"type": "tool_start", "agentId": cid, "toolUseId": write_id,
              "tool": "Write", "input": {"file_path": path, "content": note}})
        emit({"type": "tool_end", "agentId": cid, "toolUseId": write_id,
              "tool": "Write", "output": "saved", "outputTruncated": False, "isError": False})
        emit({"type": "artifact", "agentId": cid, "path": path,
              "name": f"{cid}.md", "sizeBytes": len(note)})
        emit({"type": "agent_end", "agentId": cid, "status": "completed",
              "resultText": f"{desc} done."})

    threads = [
        threading.Thread(target=run_researcher,
                         args=(cid, desc, f"{desc} query", f"# {desc}\n\nFindings.\n"))
        for cid, desc in researchers
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # sequential-after-parallel: analyst then writer
    for cid, agent_type, desc, path, name in [
        ("data-analyst-1", "data-analyst", "Extract data and comparisons",
         "files/data/data_summary.md", "data_summary.md"),
        ("report-writer-1", "report-writer", "Write final research brief",
         "files/reports/research_brief.md", "research_brief.md"),
    ]:
        emit({"type": "agent_start", "agentId": "root", "childId": cid,
              "agentType": agent_type, "description": desc, "prompt": desc})
        wid = f"{cid}-write"
        emit({"type": "tool_start", "agentId": cid, "toolUseId": wid,
              "tool": "Write", "input": {"file_path": path}})
        time.sleep(0.3)
        emit({"type": "tool_end", "agentId": cid, "toolUseId": wid,
              "tool": "Write", "output": "saved", "outputTruncated": False, "isError": False})
        emit({"type": "artifact", "agentId": cid, "path": path, "name": name, "sizeBytes": 256})
        emit({"type": "agent_end", "agentId": cid, "status": "completed", "resultText": f"{desc} done."})

    emit({"type": "response", "agentId": "root",
          "text": "Research complete. Key findings: (self-test scripted run)."})
    emit({"type": "done", "agentId": "root", "status": "success",
          "resultText": "Research complete (self-test).", "durationMs": 0, "numTurns": 0, "costUsd": None})


def run_live(inbox: Inbox) -> None:
    """Live OpenHands pipeline. Wired once the OpenHands model credentials
    authenticate, so the event mapping is validated against real OpenHands
    events rather than guessed. Emits a clear error until then."""
    text = inbox.next_message()
    emit({
        "type": "error", "agentId": "root", "source": "server",
        "message": (
            "OpenHands live engine not yet enabled: the provided OpenHands key "
            "did not authenticate against the LLM proxy. Confirm base URL, model, "
            "and key type, then the live pipeline can be activated."
        ),
    })
    emit({"type": "done", "agentId": "root", "status": "error",
          "resultText": "Live engine unavailable.", "durationMs": 0, "numTurns": 0, "costUsd": None})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    inbox = Inbox()
    inbox.start()
    try:
        if args.selftest:
            run_selftest(inbox)
        else:
            run_live(inbox)
    except Exception as exc:  # never die silently — surface to the UI
        emit({"type": "error", "agentId": "root", "source": "server",
              "message": f"runner crashed: {exc}"})
        emit({"type": "done", "agentId": "root", "status": "error",
              "resultText": "Runner crashed.", "durationMs": 0, "numTurns": 0, "costUsd": None})


if __name__ == "__main__":
    main()
