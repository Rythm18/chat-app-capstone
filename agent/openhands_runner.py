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
    Node session stamps seq/runId/ts).

MODES
  (default)  : run the live OpenHands pipeline (run_live). The lead is a real
               OpenHands agent that autonomously asks a scoping question and
               delegates to researcher/analyst/writer sub-agents via the task
               tool — the same model-driven orchestration the Claude engine
               uses. A custom visualizer maps OpenHands events to our schema.
  --selftest : emit a scripted multi-agent run (no LLM, no network) that
               exercises every normalized event type; validates the Node
               bridge without spending tokens.
"""
import sys
import json
import os
import re
import uuid
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


# Set when run_live starts so the ask_user tool executor can block on it.
_INBOX: Inbox | None = None


# --- self-test: a scripted run that drives the whole pipe without an LLM ----
def run_selftest(inbox: Inbox) -> None:
    """Emit a faithful multi-agent sequence so the Node->SSE->decoder->UI pipe
    can be validated with zero model dependency. Mirrors the real flow:
    init -> scoping question -> 2 parallel researchers -> analyst -> writer -> done."""
    text = inbox.next_message()
    if text is None:
        return

    emit({"type": "session_init", "agentId": "root", "sessionId": "selftest-session",
          "model": "openhands/selftest",
          "agentTypes": ["researcher", "data-analyst", "report-writer"]})
    time.sleep(0.2)
    emit({"type": "thinking", "agentId": "root",
          "text": f'Scoping "{text}" before dispatching researchers.'})

    qid = "selftest-q1"
    emit({"type": "ask_user", "agentId": "root", "questionId": qid, "questions": [{
        "question": "Which angle matters most for your research?",
        "header": "Focus area", "multiSelect": False,
        "options": [
            {"label": "Technical capabilities", "description": "Architecture, APIs, features"},
            {"label": "Market adoption", "description": "Usage, traction, ecosystem"},
        ]}]})
    answers = inbox.wait_for_answer(qid)
    if inbox.interrupted:
        return
    chosen = next(iter(answers.values()), "Technical capabilities")
    emit({"type": "response", "agentId": "root",
          "text": f"Focusing on {chosen}. Spawning 2 researchers in parallel."})

    researchers = [("researcher-1", "Subtopic A research"), ("researcher-2", "Subtopic B research")]
    for cid, desc in researchers:
        emit({"type": "agent_queued", "agentId": "root", "childId": cid,
              "agentType": "researcher", "description": desc, "prompt": f"Research: {desc}"})

    def run_researcher(cid: str, desc: str, note: str) -> None:
        emit({"type": "agent_start", "agentId": "root", "childId": cid,
              "agentType": "researcher", "description": desc, "prompt": f"Research: {desc}"})
        tid = f"{cid}-search"
        emit({"type": "tool_start", "agentId": cid, "toolUseId": tid,
              "tool": "WebSearch", "input": {"query": desc}})
        time.sleep(0.4)
        emit({"type": "tool_end", "agentId": cid, "toolUseId": tid, "tool": "WebSearch",
              "output": f"Results for {desc}", "outputTruncated": False, "isError": False})
        path = f"files/research_notes/{cid}.md"
        wid = f"{cid}-write"
        emit({"type": "tool_start", "agentId": cid, "toolUseId": wid,
              "tool": "Write", "input": {"file_path": path, "content": note}})
        emit({"type": "tool_end", "agentId": cid, "toolUseId": wid, "tool": "Write",
              "output": "saved", "outputTruncated": False, "isError": False})
        emit({"type": "artifact", "agentId": cid, "path": path, "name": f"{cid}.md", "sizeBytes": len(note)})
        emit({"type": "agent_end", "agentId": cid, "status": "completed", "resultText": f"{desc} done."})

    threads = [threading.Thread(target=run_researcher, args=(cid, desc, f"# {desc}\n\nFindings.\n"))
               for cid, desc in researchers]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    for cid, agent_type, desc, path, name in [
        ("data-analyst-1", "data-analyst", "Extract data and comparisons",
         "files/data/data_summary.md", "data_summary.md"),
        ("report-writer-1", "report-writer", "Write final research brief",
         "files/reports/research_brief.md", "research_brief.md")]:
        emit({"type": "agent_start", "agentId": "root", "childId": cid,
              "agentType": agent_type, "description": desc, "prompt": desc})
        wid = f"{cid}-write"
        emit({"type": "tool_start", "agentId": cid, "toolUseId": wid, "tool": "Write",
              "input": {"file_path": path}})
        time.sleep(0.3)
        emit({"type": "tool_end", "agentId": cid, "toolUseId": wid, "tool": "Write",
              "output": "saved", "outputTruncated": False, "isError": False})
        emit({"type": "artifact", "agentId": cid, "path": path, "name": name, "sizeBytes": 256})
        emit({"type": "agent_end", "agentId": cid, "status": "completed", "resultText": f"{desc} done."})

    emit({"type": "response", "agentId": "root", "text": "Research complete (self-test scripted run)."})
    emit({"type": "done", "agentId": "root", "status": "success",
          "resultText": "Research complete (self-test).", "durationMs": 0, "numTurns": 0, "costUsd": None})


# =========================================================================
# Live OpenHands pipeline (autonomous delegation)
#
# The lead is a real OpenHands agent with the task tool + a custom ask_user
# tool; it decides to ask the scoping question and to delegate, exactly like
# the Claude engine's Task-tool orchestration. We attach a custom visualizer
# to the lead conversation; the SDK calls create_sub_visualizer(label) when it
# spawns each sub-agent, so every sub-agent's events arrive tagged with a node
# id. Lifecycle signals: create_sub_visualizer = spawn, the builtin `finish`
# tool = a sub-agent finishing.
# =========================================================================
_TOOL_OUTPUT_CAP = 16000


def to_workspace_path(path: str) -> str:
    """Make an agent's file path workspace-relative so the Node artifact
    endpoint (which serves from the session workspace) can resolve it."""
    cwd = os.getcwd()
    try:
        rel = os.path.relpath(path, cwd)
    except ValueError:
        return path
    return path if rel.startswith("..") else rel


def _content_text(content: Any) -> str:
    from openhands.sdk.llm import content_to_str
    try:
        return "".join(content_to_str(content)).strip()
    except Exception:
        return str(content)


def _llm(model_env: str):
    from pydantic import SecretStr
    from openhands.sdk import LLM
    model = os.environ.get(model_env) or os.environ["LLM_MODEL"]
    return LLM(usage_id=model_env, model=model,
               base_url=os.environ.get("LLM_BASE_URL"),
               api_key=SecretStr(os.environ["LLM_API_KEY"]))


# The task TOOLSET registers as "task_tool_set", but the tool the model
# actually calls (and that appears on events) is the individual "task" tool.
_TASK_TOOL_NAMES = ("task", "task_tool_set")
_EMITTER_CLS = None
# Sub-agent node ids that got agent_start but not yet agent_end. Guarded by
# _emit_lock. Swept at run end so a sub-agent that stops without calling
# `finish` still closes (no eternal "running" node).
_open_nodes: set[str] = set()


def _emitter_class():
    """Build the visualizer class lazily (the openhands import must run after
    main() redirects sys.stdout, so the SDK banner can't corrupt the protocol).
    Maps one conversation's events to our schema; create_sub_visualizer(label)
    fires per spawned sub-agent, so each sub-agent's events arrive tagged."""
    global _EMITTER_CLS
    if _EMITTER_CLS is not None:
        return _EMITTER_CLS
    from openhands.sdk.conversation.visualizer.base import ConversationVisualizerBase

    class EmitterVisualizer(ConversationVisualizerBase):
        def __init__(self, node_id: str, agent_type: str, types: dict[str, str]):
            super().__init__()
            self._node = node_id
            self._agent_type = agent_type
            self._types = types          # description -> subagent_type (shared from root)
            self._pending: dict[str, dict] = {}  # tool_call_id -> {tool, input}

        def on_event(self, event: Any) -> None:
            kind = type(event).__name__
            if kind == "ActionEvent":
                self._on_action(event)
            elif kind == "ObservationEvent":
                self._on_observation(event)
            elif kind == "MessageEvent" and getattr(event, "source", None) == "agent":
                text = _content_text(event.llm_message.content)
                if text:
                    emit({"type": "response", "agentId": self._node, "text": text})
            elif kind == "AgentErrorEvent":
                emit({"type": "error", "agentId": self._node, "source": "agent",
                      "message": str(getattr(event, "error", event))})

        def _on_action(self, event: Any) -> None:
            tool = event.tool_name
            try:
                args = json.loads(event.tool_call.arguments)
            except Exception:
                args = {}

            thought = _content_text(list(event.thought))
            if thought:
                emit({"type": "thinking", "agentId": self._node, "text": thought})

            if tool in _TASK_TOOL_NAMES or "subagent_type" in args:
                # delegation: record the type so create_sub_visualizer can label
                # the node, and mark it queued. Suppress as a generic tool call.
                desc = args.get("description") or ""
                if desc:
                    self._types[desc] = args.get("subagent_type", "agent")
                    emit({"type": "agent_queued", "agentId": self._node, "childId": desc,
                          "agentType": self._types[desc], "description": desc,
                          "prompt": args.get("prompt", "")})
                return
            if tool == "ask_user":
                return  # the ask_user executor emits the ask_user event itself
            if tool == "finish":
                if self._node != "root":  # a sub-agent finishing
                    with _emit_lock:
                        was_open = self._node in _open_nodes
                        _open_nodes.discard(self._node)
                    if was_open:
                        emit({"type": "agent_end", "agentId": self._node, "status": "completed",
                              "resultText": args.get("message", "")})
                return

            self._pending[event.tool_call_id] = {"tool": tool, "input": args}
            emit({"type": "tool_start", "agentId": self._node, "toolUseId": event.tool_call_id,
                  "tool": tool, "input": args})

        def _on_observation(self, event: Any) -> None:
            if event.tool_name in _TASK_TOOL_NAMES or event.tool_name in ("ask_user", "finish"):
                return  # delegation/ask/finish results aren't tool steps
            call = self._pending.pop(event.tool_call_id, {"tool": event.tool_name, "input": {}})
            output = _content_text(event.observation.to_llm_content)
            emit({"type": "tool_end", "agentId": self._node, "toolUseId": event.tool_call_id,
                  "tool": event.tool_name, "output": output[:_TOOL_OUTPUT_CAP],
                  "outputTruncated": len(output) > _TOOL_OUTPUT_CAP, "isError": False})
            # a successful file create is an artifact
            path = call["input"].get("path") or call["input"].get("file_path")
            command = call["input"].get("command")
            if isinstance(path, str) and command in ("create", "write", None) and "file" in call["tool"].lower():
                rel = to_workspace_path(path)
                emit({"type": "artifact", "agentId": self._node, "path": rel,
                      "name": rel.split("/")[-1], "sizeBytes": len(call["input"].get("file_text", "") or "")})

        def create_sub_visualizer(self, agent_id: str):
            """agent_id is the task description (the manager's label). Emit the
            start and hand back a visualizer tagged with this node id."""
            atype = self._types.get(agent_id, "agent")
            with _emit_lock:
                _open_nodes.add(agent_id)
            emit({"type": "agent_start", "agentId": self._node, "childId": agent_id,
                  "agentType": atype, "description": agent_id, "prompt": ""})
            return _EMITTER_CLS(agent_id, atype, self._types)

    _EMITTER_CLS = EmitterVisualizer
    return _EMITTER_CLS


def _register_agents() -> None:
    """Register the three pipeline sub-agent types. Each factory ignores the
    passed LLM and uses the cheaper sub-model; each ends by calling `finish`."""
    from openhands.sdk import Agent, Tool
    from openhands.sdk.subagent import register_agent
    from openhands.tools.terminal import TerminalTool
    from openhands.tools.file_editor import FileEditorTool

    research_tools = [Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)]

    # All file paths MUST be relative to the working directory (never absolute,
    # never /tmp) so artifacts land in the session workspace and stay servable.
    paths_rule = (
        " ALWAYS write files to RELATIVE paths under the current working directory "
        "(e.g. files/research_notes/x.md). NEVER use absolute paths, /tmp, or ~. "
        "When done, call the finish tool.")

    def researcher(_llm_unused):
        return Agent(llm=_llm("LLM_MODEL_SUB"), tools=research_tools, system_prompt=(
            "You are a focused web researcher. Use the terminal (curl) to gather "
            "information and the file editor to save concise markdown findings to "
            "files/research_notes/. Keep it brief: 1-2 fetches, then write your notes." + paths_rule))

    def analyst(_llm_unused):
        return Agent(llm=_llm("LLM_MODEL_SUB"), tools=research_tools, system_prompt=(
            "You are a data analyst. Read the notes in files/research_notes/, extract key "
            "quantitative points and comparisons, and write a concise markdown summary to "
            "files/data/data_summary.md." + paths_rule))

    def writer(_llm_unused):
        return Agent(llm=_llm("LLM_MODEL_SUB"), tools=research_tools, system_prompt=(
            "You are a report writer. Read files/research_notes/ and files/data/data_summary.md, "
            "then write a clear, well-structured markdown research brief to "
            "files/reports/research_brief.md, ending with a 3-5 bullet key-findings summary." + paths_rule))

    register_agent(name="researcher", factory_func=researcher,
                   description="Researches one subtopic via the web and saves markdown notes.")
    register_agent(name="data-analyst", factory_func=analyst,
                   description="Reads research notes and writes a markdown data summary.")
    register_agent(name="report-writer", factory_func=writer,
                   description="Synthesizes notes and data into the final markdown brief.")


def _register_ask_user_tool() -> None:
    """Register a custom ask_user tool the lead calls to pause for the user."""
    from pydantic import Field
    from openhands.sdk.tool.tool import Action, Observation, ToolDefinition, ToolExecutor

    class AskUserAction(Action):
        question: str = Field(description="The single scoping question to ask the user.")
        header: str = Field(default="Focus", description="Short label for the question.")
        options: list[str] = Field(description="2-4 concrete answer options.")

    class AskUserObservation(Observation):
        pass

    class AskUserExecutor(ToolExecutor):
        def __call__(self, action: AskUserAction, conversation: Any = None) -> AskUserObservation:
            qid = f"ask-{uuid.uuid4().hex[:8]}"
            emit({"type": "ask_user", "agentId": "root", "questionId": qid, "questions": [{
                "question": action.question, "header": action.header, "multiSelect": False,
                "options": [{"label": o, "description": ""} for o in action.options]}]})
            answers = _INBOX.wait_for_answer(qid) if _INBOX else {}
            chosen = next(iter(answers.values()), action.options[0] if action.options else "")
            return AskUserObservation.from_text(text=f"The user chose: {chosen}")

    class AskUserTool(ToolDefinition[AskUserAction, AskUserObservation]):
        @classmethod
        def create(cls, conv_state: Any = None, **params):
            return [cls(description=(
                "Ask the user ONE scoping question with 2-4 concrete options. "
                "Use this once at the very start to focus the research."),
                action_type=AskUserAction, observation_type=AskUserObservation,
                executor=AskUserExecutor())]

    from openhands.sdk import register_tool
    register_tool(AskUserTool.name, AskUserTool)
    return AskUserTool.name


_LEAD_PROMPT = (
    "You are a lead research coordinator. You NEVER research, analyze, or write yourself — "
    "you only ask one scoping question and then delegate.\n"
    "STEP 1: Call the ask_user tool exactly ONCE with a scoping question (2-4 concrete options) "
    "about which angle of the topic matters most.\n"
    "STEP 2: Decide how many distinct subtopics the request genuinely warrants — as few or as many "
    "as the topic needs, but NEVER more than 5. Using the task tool, delegate to that many "
    "'researcher' subagents IN PARALLEL (one task call each, all in the SAME message), each with a "
    "distinct subtopic shaped by the chosen angle. Give each a short 3-5 word description and a "
    "clear prompt to research and save notes.\n"
    "STEP 3: After ALL researchers finish, delegate to ONE 'data-analyst' subagent.\n"
    "STEP 4: Then delegate to ONE 'report-writer' subagent.\n"
    "STEP 5: Finish with a 3-5 bullet summary of the key findings.\n"
    "Keep your own messages short. Always use the tools; never produce research content yourself."
)


def run_live(inbox: Inbox) -> None:
    global _INBOX
    _INBOX = inbox

    from openhands.sdk import Agent, Conversation, Tool
    from openhands.tools import register_builtins_agents
    from openhands.tools.task import TaskToolSet

    register_builtins_agents()
    _register_agents()
    ask_user_name = _register_ask_user_tool()

    # One process per session; loop so follow-up messages continue the chat.
    while True:
        topic = inbox.next_message()
        if topic is None or inbox.interrupted:
            return

        with _emit_lock:
            _open_nodes.clear()
        emit({"type": "session_init", "agentId": "root",
              "sessionId": os.environ.get("LLM_MODEL", "openhands"),
              "model": os.environ.get("LLM_MODEL", "openhands"),
              "agentTypes": ["researcher", "data-analyst", "report-writer"]})

        lead = Agent(llm=_llm("LLM_MODEL"),
                     tools=[Tool(name=TaskToolSet.name), Tool(name=ask_user_name)],
                     system_prompt=_LEAD_PROMPT, tool_concurrency_limit=5)
        Emitter = _emitter_class()
        conversation = Conversation(
            agent=lead, workspace=os.getcwd(),
            visualizer=Emitter("root", "orchestrator", {}),
            max_iteration_per_run=40)

        try:
            conversation.send_message(f"Research request: {topic}")
            conversation.run()
            # Close any sub-agent that stopped without calling finish.
            with _emit_lock:
                stragglers = list(_open_nodes)
                _open_nodes.clear()
            for nid in stragglers:
                emit({"type": "agent_end", "agentId": nid, "status": "completed", "resultText": ""})
            from openhands.sdk.conversation.response_utils import get_agent_final_response
            final = get_agent_final_response(conversation.state.events) or "Research complete."
            emit({"type": "done", "agentId": "root", "status": "success",
                  "resultText": final, "durationMs": 0, "numTurns": 0, "costUsd": None})
        except Exception as exc:
            emit({"type": "error", "agentId": "root", "source": "server", "message": str(exc)})
            emit({"type": "done", "agentId": "root", "status": "error",
                  "resultText": f"Run failed: {exc}", "durationMs": 0, "numTurns": 0, "costUsd": None})


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
        run_selftest(inbox) if args.selftest else run_live(inbox)
    except Exception as exc:  # never die silently — surface to the UI
        emit({"type": "error", "agentId": "root", "source": "server",
              "message": f"runner crashed: {exc}"})
        emit({"type": "done", "agentId": "root", "status": "error",
              "resultText": "Runner crashed.", "durationMs": 0, "numTurns": 0, "costUsd": None})


if __name__ == "__main__":
    main()
