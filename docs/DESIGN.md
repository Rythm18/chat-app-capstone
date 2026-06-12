# Deep Analyst: An Agent-Transparent Chat Application

**Author:** Ridham Khandar · **Date:** 2026-06-12 · **Status:** Shipped

## Tenets

1. **The stream is the single source of truth.** Any consumer that replays the event stream from seq 0 arrives at identical UI state. Reconnection, page refresh, and testing are all the same operation.
2. **Decode is pure.** The event-stream-to-tree logic has zero framework imports. It is exercised identically by React and by tests.
3. **Nothing is hardcoded to our agents.** Routing keys are tool-use ids; names, types, and descriptions are display data carried by events. A foreign agent set renders correctly (verified by accident, when a config bug let the host machine's own plugins into a run).
4. **Design from recorded reality, not from documentation.** Every schema decision traces to a captured fixture of real SDK output. Two undocumented SDK behaviors were caught this way that docs-driven design would have missed.
5. **The chat never lies about being busy.** From the instant a message is sent to the final brief, something on screen is moving: status pills, live elapsed timers, streaming text, an activity ticker.

## Problem

Multi-agent systems do minutes of invisible work. A normal chat UI shows a spinner and then a wall of text — users can't see what agents are doing, whether parallelism is real, why the run paused, or where output files came from. The Claude Agent SDK exposes all of this, but as a flat stream of 30+ heterogeneous message types that must be decoded, routed to the right node of a *growing* execution tree, and rendered live without racing.

## Proposed solution

A three-layer pipeline with one shared contract. The server runs the SDK and **normalizes** raw messages into 15 typed events, each stamped with a monotonic `seq` and the id of the trace-tree node it belongs to (`parent_tool_use_id`-derived). Events stream over SSE with `id = seq`, making resume-after-disconnect native `EventSource` behavior. The browser folds events through a **pure reducer** into per-run trace trees and renders them as a two-pane console: chat left, execution trace right.

The four key design questions:

- **Single message or multiple?** Multiple. Each user message opens a *run* with its own trace tree under the same session; older runs auto-collapse to a summary line. The SDK session persists across runs, so follow-ups keep context.
- **How do parallel agents appear?** Sub-agent nodes are keyed by the spawning call's `tool_use_id`, so two simultaneous `researcher` agents are distinct nodes ("researcher #1/#2"). Children whose lifetimes overlap are grouped into a wave rendered **side-by-side** under a `∥ PARALLEL ×N` badge. Grouping is computed from start/end timestamps — it survives completion, replay, and reconnect rather than depending on live status.
- **What happens during ask_user?** The SDK's `canUseTool` callback parks the agent on a server-side promise — the SSE stream stays open, simply quiet. The UI flips run and node to `awaiting_input`, surfaces a question card in the chat (options + free text), and `POST /answers` resolves the promise. The trace keeps a permanent record of question and answer.
- **How are artifacts surfaced?** The normalizer derives `artifact` events from successful `Write` results — no agent cooperation required. The decoder dedupes by path (latest write wins) and attributes each artifact to its producing agent. The final brief is detected (reports directory heuristic) and rendered **inline in the chat** as the run's deliverable; other artifacts are chips opening a viewer. Files are served only from the session's workspace, path-traversal guarded.

## Goals

- All ten must-have requirements, with decode correctness proven by tests: 18 unit tests (routing, clobber-resistance, pause/resume) plus an integration test replaying a full 468-event recorded run through the real normalizer and decoder.
- Real-run verified: parallel researchers, deterministic scoping question, artifacts, inline brief.
- Zero-cost development loop: a recorded fixture replays through the production pipeline, including an interactive ask_user pause.

## Non-goals

- Persistence across server restarts (page refresh is supported via stream replay; durable storage is stretch #16 and out of scope).
- Multi-user auth, deployment hardening, or horizontal scale — single-machine demo.
- Agent quality tuning beyond what transparency demands (the rubric grades the chat application, not the research).
- Executing agent-generated code (sub-agents deliberately have no Bash).

## Open questions

- **SDK drift.** Two behaviors we depend on were learned from the binary, not docs (the `Agent` wire-name for spawns; the sub-agent report-write guardrail). Version upgrades need a fixture re-capture to re-verify.
- **Thinking verbosity.** We render all forwarded thinking text; long runs may want a server-side policy (truncate, summarize, or sample) rather than a UI scrollbar.
- **Queued fidelity.** `agent_queued` derives from dispatch-before-start ordering. If a future SDK starts tasks atomically with dispatch, the queued state quietly disappears — harmless, but the status legend would overpromise.
- **ask_user from sub-agents.** Questions are currently attributed to the orchestrator, correct for this agent set. If sub-agents gained the tool, attribution needs the question's originating context — the schema already carries it, the runner does not yet.
