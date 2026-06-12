# Deep Analyst: An Agent-Transparent Chat Application

**Author:** Ridham Khandar · **Date:** 2026-06-11

## Tenets

1. **The stream is the single source of truth.** Any consumer that replays the event stream from the beginning must arrive at identical UI state. If we hold this, reconnection, page refresh, and testing all become the same operation: replay.
2. **Decode is pure.** The stream-to-tree logic will have zero framework imports, so tests and the live UI exercise the exact same code.
3. **Nothing hardcoded to our agents.** Routing keys are tool-use ids; agent names, types, and descriptions are display data carried by events. The decoder must correctly render an agent set it has never seen.
4. **Design from recorded reality, not documentation.** Before committing to an event schema, capture a complete real SDK run to a fixture and derive shapes from observed payloads. Docs are hints; the wire is truth.
5. **The chat never lies about being busy.** From message-send to final brief, something on screen must always reflect live agent state.

## Problem

Multi-agent systems do minutes of invisible work. A conventional chat UI shows a spinner and then a wall of text — users cannot see what agents are doing, whether parallelism is real, why a run paused, or where output files came from. The Claude Agent SDK exposes all of this, but as a flat stream of 30+ heterogeneous message types that must be decoded, routed to the correct node of a tree that *grows during the run*, and rendered live without races.

## Proposed solution

A three-layer pipeline with one shared contract. The server runs the SDK and **normalizes** raw messages into a small set (~15) of typed events, each carrying the id of the trace-tree node it belongs to (derived from `parent_tool_use_id`) and a monotonic `seq` stamped at emit time. Events stream to the browser over SSE with `id = seq`, so resuming after a disconnect is native `EventSource` behavior. The browser folds events through a **pure reducer** into per-run trace trees and renders a two-pane console: chat left, execution trace right. A recorded fixture will replay through this same production pipeline as a mock mode, so the frontend can be built and demoed with zero API spend.

The four key design questions:

- **Single message or multiple?** Multiple. Each user message opens a *run* with its own trace tree inside one persistent session; older runs collapse to a summary line. The alternative — one accumulated tree per session — is simpler state, but follow-up questions would interleave into the same tree and history would become unreadable.
- **How do parallel agents appear?** Sub-agent nodes are keyed by the spawning call's `tool_use_id`, so two simultaneous agents of the same type stay distinct ("researcher #1/#2"). Children whose lifetimes overlap render **side-by-side** under a `∥ PARALLEL` badge. Grouping will be computed from recorded start/end timestamps rather than live status flags, so the parallel shape survives completion, refresh, and replay. A Gantt/swimlane view was considered and rejected: heavier to build and worse for showing nested step detail.
- **What happens during ask_user?** The SDK's `canUseTool` permission callback parks the agent on a server-side promise: we emit an `ask_user` event, and simply do not return until the browser POSTs an answer. The SSE connection stays open but quiet — there is nothing to close, so the close-the-stream pitfall cannot occur. The UI flips run and node to `awaiting_input` and surfaces a question card in the chat; the answer is injected into the tool result and the trace keeps a permanent Q&A record.
- **How are artifacts surfaced?** Derived, not declared: the normalizer turns every successful `Write` tool result into an `artifact` event — no agent cooperation required. The decoder dedupes by path (latest write wins) and attributes each artifact to its producing agent. The final brief renders inline in the chat as the run's deliverable; other artifacts are chips opening a viewer, served only from the session's workspace with path-traversal guarding. The alternative — prompting agents to announce their outputs — was rejected as unreliable.

## Goals

- All ten must-have requirements, with decode correctness provable: unit tests per event type (routing, parallel clobber-resistance, pause/resume) plus an integration test that replays the captured fixture end-to-end and asserts the resulting tree.
- ask_user pause/resume working end-to-end without dropping the stream.
- Parallel visibly distinct from sequential — including after the run completes.
- A zero-cost development loop (fixture replay); live mode as a config flip, not a code change.
- Stretch, time permitting: resume-on-reconnect, auto-collapse of completed nodes, multi-run stacking, an activity ticker.

## Non-goals

- Persistence across server restarts (page refresh must work via stream replay; durable storage is stretch scope).
- Multi-user auth, deployment hardening, horizontal scale — this is a single-machine demo.
- Agent research quality beyond what transparency demands; the rubric grades the chat application.
- Executing agent-generated code (sub-agents get no Bash, by design).

## Open questions

- **Can "queued" be honest?** If the SDK emits the Task dispatch before the sub-agent actually starts, that gap yields a true queued state; if starts are atomic with dispatch, a queued indicator would overpromise. Resolve by inspecting the captured fixture.
- **How faithful are the docs to the wire?** Event shapes, field names, and tool names may differ from documentation across SDK versions. Mitigation is tenet 4 — fixture-first design — but version upgrades will need a re-capture.
- **Thinking-text volume.** Rendering all forwarded thinking is the product's point, but long runs may need a server-side policy (truncate, sample, or summarize) rather than a UI scrollbar.
- **ask_user from sub-agents.** Our agent set gives the question tool only to the orchestrator. The event schema should carry the asking node's id from day one so that, if sub-agents ever gain the tool, only the runner needs to change.
- **Live-run budget.** Real runs cost real money and rate-limit headroom; development must lean on replay, with live runs reserved for verification milestones.
