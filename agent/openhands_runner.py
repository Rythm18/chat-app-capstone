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
  (default)  : run the live OpenHands pipeline (run_live) — real OpenHands
               agents scope, research in parallel, analyze, and write.
  --selftest : emit a scripted multi-agent run (no LLM, no network) that
               exercises every normalized event type; used to validate the
               Node bridge without spending tokens.
"""
import sys
import json
import os
import re
import threading
import time
import argparse
from typing import Any


# --- stdout: thread-safe, line-buffered emit of normalized event bodies -----
# The OpenHands SDK prints Rich UI to stdout, which would corrupt our JSON
# protocol. We capture the real stdout here for emit() and later point
# sys.stdout at stderr so any library output is logged, not parsed.
_OUT = sys.stdout
_emit_lock = threading.Lock()


def emit(body: dict[str, Any]) -> None:
    """Write one normalized AgentEventBody as a JSON line. Thread-safe so
    parallel sub-agents (separate threads) can't interleave a line."""
    line = json.dumps(body, ensure_ascii=False)
    with _emit_lock:
        _OUT.write(line + "\n")
        _OUT.flush()


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


# =========================================================================
# Live OpenHands pipeline
#
# Genuine OpenHands agents (Agent + Conversation + tools, on the model behind
# LLM_BASE_URL) do the work; orchestration is Python-driven for determinism
# across models. Each node is a real OpenHands Conversation whose callback
# maps OpenHands events -> our normalized schema, tagged with the node id.
# =========================================================================


def to_workspace_path(path: str) -> str:
    """Make an agent's file path workspace-relative so the Node artifact
    endpoint (which serves from the session workspace) can resolve it."""
    cwd = os.getcwd()
    try:
        rel = os.path.relpath(path, cwd)
    except ValueError:
        return path
    return path if rel.startswith("..") else rel


def _llm(model_env: str):
    from pydantic import SecretStr
    from openhands.sdk import LLM
    return LLM(
        usage_id=model_env,
        model=os.environ[model_env] if model_env in os.environ else os.environ["LLM_MODEL"],
        base_url=os.environ.get("LLM_BASE_URL"),
        api_key=SecretStr(os.environ["LLM_API_KEY"]),
    )


def _complete_json(llm, prompt: str) -> Any:
    """One-shot completion expected to return JSON; tolerant of code fences."""
    from openhands.sdk.llm import Message, TextContent, content_to_str
    resp = llm.completion(messages=[Message(role="user", content=[TextContent(text=prompt)])])
    text = "".join(content_to_str(resp.message.content)).strip()
    match = re.search(r"\{.*\}|\[.*\]", text, re.DOTALL)
    try:
        return json.loads(match.group(0) if match else text)
    except Exception:
        return None


def _make_callback(node_id: str):
    """Map this conversation's OpenHands events to normalized events tagged
    with node_id. Per-node tool tracking lives in this closure (one callback
    per conversation), so parallel sub-agents never share state."""
    from openhands.sdk.event import ActionEvent, ObservationEvent, MessageEvent, AgentErrorEvent
    from openhands.sdk.llm import content_to_str

    pending: dict[str, dict] = {}  # tool_call_id -> {tool, input}

    def cb(event: Any) -> None:
        if isinstance(event, ActionEvent):
            thought = "".join(content_to_str(list(event.thought))).strip()
            if thought:
                emit({"type": "thinking", "agentId": node_id, "text": thought})
            try:
                args = json.loads(event.tool_call.arguments)
            except Exception:
                args = {}
            pending[event.tool_call_id] = {"tool": event.tool_name, "input": args}
            emit({"type": "tool_start", "agentId": node_id, "toolUseId": event.tool_call_id,
                  "tool": event.tool_name, "input": args})
        elif isinstance(event, ObservationEvent):
            call = pending.pop(event.tool_call_id, {"tool": event.tool_name, "input": {}})
            output = "".join(content_to_str(event.observation.to_llm_content))
            emit({"type": "tool_end", "agentId": node_id, "toolUseId": event.tool_call_id,
                  "tool": event.tool_name, "output": output[:16000],
                  "outputTruncated": len(output) > 16000, "isError": False})
            # a successful file create is an artifact
            path = call["input"].get("path") or call["input"].get("file_path")
            command = call["input"].get("command")
            if isinstance(path, str) and command in ("create", "write", None) and "file" in call["tool"].lower():
                rel = to_workspace_path(path)
                emit({"type": "artifact", "agentId": node_id, "path": rel,
                      "name": rel.split("/")[-1], "sizeBytes": len(call["input"].get("file_text", "") or "")})
        elif isinstance(event, MessageEvent) and event.source == "agent":
            text = "".join(content_to_str(event.llm_message.content)).strip()
            if text:
                emit({"type": "response", "agentId": node_id, "text": text})
        elif isinstance(event, AgentErrorEvent):
            emit({"type": "error", "agentId": node_id, "source": "agent",
                  "message": getattr(event, "error", str(event))})

    return cb


def _run_agent(node_id: str, agent_type: str, description: str,
               system_prompt: str, task: str, tool_names: list[str],
               model_env: str, max_iter: int = 12) -> str:
    """Run one OpenHands agent to completion as a tree node. Returns its final text."""
    from openhands.sdk import Agent, Conversation, Tool

    agent = Agent(llm=_llm(model_env),
                  tools=[Tool(name=n) for n in tool_names],
                  system_prompt=system_prompt)
    conversation = Conversation(
        agent=agent, workspace=os.getcwd(),
        callbacks=[_make_callback(node_id)],
        visualizer=None, max_iteration_per_run=max_iter,
    )
    conversation.send_message(task)
    conversation.run()
    from openhands.sdk.conversation.response_utils import get_agent_final_response
    return get_agent_final_response(conversation.state.events) or ""


def run_live(inbox: Inbox) -> None:
    topic = inbox.next_message()
    if topic is None:
        return

    from openhands.tools.terminal import TerminalTool
    from openhands.tools.file_editor import FileEditorTool
    research_tools = [TerminalTool.name, FileEditorTool.name]

    lead_llm = _llm("LLM_MODEL")
    emit({"type": "session_init", "agentId": "root",
          "sessionId": os.environ.get("LLM_MODEL", "openhands"),
          "model": os.environ.get("LLM_MODEL", "openhands"),
          "agentTypes": ["researcher", "data-analyst", "report-writer"]})

    # --- lead: scope, then decompose -------------------------------------
    emit({"type": "thinking", "agentId": "root", "text": f"Scoping the request: {topic}"})
    scope = _complete_json(lead_llm, (
        "You are a research lead. For the request below, produce ONE scoping question "
        "with 2-4 concrete answer options. Reply ONLY as JSON: "
        '{"question": "...", "header": "Focus", "options": [{"label":"...","description":"..."}]}\n\n'
        f"Request: {topic}"))
    if not scope or "question" not in scope:
        scope = {"question": "Which angle matters most for your research?",
                 "header": "Focus area",
                 "options": [{"label": "Overview", "description": "Broad survey"},
                             {"label": "Deep technical", "description": "Mechanisms and detail"}]}
    qid = "scope-1"
    emit({"type": "ask_user", "agentId": "root", "questionId": qid, "questions": [
        {"question": scope["question"], "header": scope.get("header", "Focus"),
         "multiSelect": False, "options": scope["options"]}]})
    answers = inbox.wait_for_answer(qid)
    if inbox.interrupted:
        return
    angle = next(iter(answers.values()), scope["options"][0]["label"])
    emit({"type": "response", "agentId": "root",
          "text": f"Focusing on {angle}. Decomposing into subtopics."})

    plan = _complete_json(lead_llm, (
        f"Research request: {topic}\nChosen angle: {angle}\n"
        "Break this into exactly 2 focused, distinct research subtopics. "
        'Reply ONLY as JSON: {"subtopics": ["...", "..."]}'))
    subtopics = (plan or {}).get("subtopics") or [f"{topic} — overview", f"{topic} — current developments"]
    subtopics = subtopics[:2]

    # --- researchers in parallel -----------------------------------------
    researchers = [(f"researcher-{i+1}", st) for i, st in enumerate(subtopics)]
    for cid, st in researchers:
        emit({"type": "agent_queued", "agentId": "root", "childId": cid,
              "agentType": "researcher", "description": st, "prompt": st})

    def run_researcher(cid: str, subtopic: str) -> None:
        emit({"type": "agent_start", "agentId": "root", "childId": cid,
              "agentType": "researcher", "description": subtopic, "prompt": subtopic})
        try:
            _run_agent(
                cid, "researcher", subtopic,
                system_prompt=(
                    "You are a focused web researcher. Use the terminal (curl) to gather "
                    "information and the file editor to save concise markdown findings. "
                    "Keep it brief: 1-2 fetches, then write your notes."),
                task=(f"Research this subtopic: {subtopic}\n"
                      f"Save your findings to files/research_notes/{cid}.md as markdown. "
                      "Be concise."),
                tool_names=research_tools, model_env="LLM_MODEL_SUB", max_iter=10)
            emit({"type": "agent_end", "agentId": cid, "status": "completed",
                  "resultText": f"Research on '{subtopic}' complete."})
        except Exception as exc:
            emit({"type": "agent_end", "agentId": cid, "status": "failed", "resultText": str(exc)})

    threads = [threading.Thread(target=run_researcher, args=(cid, st)) for cid, st in researchers]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if inbox.interrupted:
        return

    # --- analyst, then writer (sequential after parallel) ----------------
    analyst_id = "data-analyst-1"
    emit({"type": "agent_start", "agentId": "root", "childId": analyst_id,
          "agentType": "data-analyst", "description": "Extract data and comparisons", "prompt": ""})
    try:
        _run_agent(
            analyst_id, "data-analyst", "Extract data and comparisons",
            system_prompt=("You are a data analyst. Read the research notes and extract key "
                           "quantitative points and comparisons into a concise markdown summary."),
            task=("Read all files in files/research_notes/, then write a concise markdown data "
                  "summary with any comparison tables to files/data/data_summary.md."),
            tool_names=research_tools, model_env="LLM_MODEL_SUB", max_iter=10)
        emit({"type": "agent_end", "agentId": analyst_id, "status": "completed", "resultText": "Data summary written."})
    except Exception as exc:
        emit({"type": "agent_end", "agentId": analyst_id, "status": "failed", "resultText": str(exc)})

    writer_id = "report-writer-1"
    emit({"type": "agent_start", "agentId": "root", "childId": writer_id,
          "agentType": "report-writer", "description": "Write final research brief", "prompt": ""})
    final_text = ""
    try:
        final_text = _run_agent(
            writer_id, "report-writer", "Write final research brief",
            system_prompt=("You are a report writer. Synthesize the research notes and data summary "
                           "into a clear, well-structured markdown research brief."),
            task=("Read files/research_notes/ and files/data/data_summary.md, then write a "
                  "comprehensive markdown research brief to files/reports/research_brief.md. "
                  "End your reply with a 3-5 bullet summary of the key findings."),
            tool_names=research_tools, model_env="LLM_MODEL_SUB", max_iter=12)
        emit({"type": "agent_end", "agentId": writer_id, "status": "completed", "resultText": "Brief written."})
    except Exception as exc:
        emit({"type": "agent_end", "agentId": writer_id, "status": "failed", "resultText": str(exc)})

    emit({"type": "response", "agentId": "root",
          "text": final_text or "Research complete. See the brief and artifacts."})
    emit({"type": "done", "agentId": "root", "status": "success",
          "resultText": final_text or "Research complete.", "durationMs": 0, "numTurns": 0, "costUsd": None})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    # Protect the JSON protocol: any SDK/library output goes to stderr.
    os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")
    sys.stdout = sys.stderr

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
