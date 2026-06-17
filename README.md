# Deep Analyst — Agent-Transparent Chat

A chat application with the engine cover off. You ask a research question; a lead agent decomposes it, pauses to ask you a scoping question, dispatches researcher sub-agents **in parallel**, then runs a data analyst and a report writer — and the UI shows every thinking step, tool call, sub-agent lifecycle, and artifact **live**, as a growing execution trace.

Built for the agent-transparent chat capstone (Domain A: "Deep Analyst"). The one-page design document is at [docs/DESIGN.md](docs/DESIGN.md).

**Two interchangeable agent engines, one app.** The entire backend, decoder, UI, and tests are engine-agnostic because everything downstream consumes a single normalized event schema (`shared/events.ts`). A run can be driven by:

- **OpenHands SDK** (default) — the open-source agent SDK, on any model via its LiteLLM proxy. Runs as a Python sidecar.
- **Claude Agent SDK** — `ENGINE=claude`.
- **Mock replay** — a recorded run, no API cost.

Swapping engines touches only the runner + normalizer; the decoder/UI/tests don't change. See [the engines section](#agent-engines) below.

## Quick start

Prerequisites: Node 20+. Python 3.12+ and [`uv`](https://docs.astral.sh/uv/) only if you run the OpenHands engine.

```bash
npm install

# terminal 1 — backend (live agents)
npm run dev:server          # OpenHands engine (default) — needs .env, see below
# or:  npm run dev:server:claude   # Claude Agent SDK engine
# or:  MOCK=1 npm run dev:server    # recorded replay, no key, no cost

# terminal 2 — frontend
npm run dev:client
```

Open the URL Vite prints (default `http://localhost:5173`).

### OpenHands engine setup (default)

```bash
uv venv agent/.venv --python 3.12
VIRTUAL_ENV=agent/.venv uv pip install -r agent/requirements.txt
```

Create `.env` with an OpenHands LLM proxy key (any LiteLLM-supported model works):

```
LLM_API_KEY=sk-...
LLM_BASE_URL=https://llm-proxy.app.all-hands.dev
LLM_MODEL=litellm_proxy/claude-sonnet-4-6
LLM_MODEL_SUB=litellm_proxy/claude-haiku-4-5-20251001
```

A live run takes a few minutes; cost depends on the model (sub-agents use the cheaper `LLM_MODEL_SUB`).

### Claude engine

`ENGINE=claude npm run dev:server` — needs a logged-in Claude CLI (`claude login`) or `ANTHROPIC_API_KEY`.

### Mock mode — no API cost

```bash
MOCK=1 npm run dev:server
```

Replays a complete recorded multi-agent run (`fixtures/run-001.jsonl`, 468 real SDK events) through the exact same normalizer → SSE → decoder pipeline, compressed to ~1 minute. The ask_user pause is genuinely interactive — the replay blocks until you answer in the browser. `MOCK_SPEED=4` to go faster.

## Architecture

```
┌──────────────────────────────── server ───────────────────────────────┐
│                                                                        │
│  Claude Agent SDK ──► Normalizer ──► ChatSession ──► SSE /stream       │
│  (raw, 30+ msg types)  (15 typed     (seq-stamped                      │
│       ▲                 events)       event log,                       │
│       │                               fan-out)                         │
│  canUseTool ◄──────────────────────── POST /answers                    │
│  (ask_user pause)                                                      │
└────────────────────────────────────────────────────────────────────────┘
                                          │ SSE (id = seq)
┌──────────────────────────────── client ───────────────────────────────┐
│  useSession (transport) ──► decode() (pure reducer) ──► React render   │
└────────────────────────────────────────────────────────────────────────┘
```

Three strictly separated layers, one shared contract:

- **`shared/events.ts`** — the normalized event schema (15 typed events). The browser never sees a raw SDK message; the server never knows what the UI looks like.
- **`server/normalize.ts`** — maps raw SDK messages to normalized events. Routes every event to its trace-tree node via `parent_tool_use_id`, detects sub-agent spawns (emitting an honest `queued → running` transition), converts successful `Write` results into `artifact` events.
- **`shared/decoder.ts`** — a pure reducer `(state, event) → state` with zero framework imports. Folds the flat event stream into per-run trace trees: nodes keyed by the spawning call's `tool_use_id` (never by agent name — two parallel researchers of the same type stay distinct), ordered steps per node, streaming-text buffers, artifact dedup, ask_user pause/resume.
- **`client/`** — React renders the decoder state. `useSession` owns the EventSource; everything else is presentation.

Raw observations from the recorded runs are in [docs/notes/sdk-event-observations.md](docs/notes/sdk-event-observations.md).

### Key mechanics

- **Resumable stream** — SSE event ids are per-session sequence numbers; `EventSource` auto-reconnect sends `Last-Event-ID`, and the server replays everything after it. A fresh page load replays from 0 and the decoder rebuilds identical state — the stream is the single source of truth.
- **Persistence across restarts** — every emitted event is appended to `data/<id>.jsonl`; on boot the server replays each log to rebuild its sessions in memory. The browser remembers its session id (`localStorage`) and resumes it, so closing the tab or restarting the server preserves the full trace. The decoder needs zero changes — it already rebuilds from events. A run that was mid-flight at shutdown is finalized as interrupted (so no eternal spinners) and offered a retry.
- **ask_user without closing the stream** — `AskUserQuestion` is intercepted in `canUseTool`, which parks the agent on a server-side promise. The browser shows the question card; `POST /answers` resolves the promise and the run resumes. The SSE connection never drops.
- **Parallel visualization** — children whose lifetimes overlap (by timestamp) are grouped into a "wave" and rendered side-by-side under a `∥ PARALLEL` badge; the grouping is derived from data, so it survives completion and replay.
- **Artifacts** — derived from successful `Write` calls, deduped by path (latest wins), attributed to the producing agent, served only from inside the session's workspace (path-traversal guarded). The final brief renders inline in the chat.
- **Stop & retry** — a running trace shows a STOP button (`query.interrupt()`, with a synthetic terminal event as a fallback); a failed or interrupted run shows a RERUN button that re-submits the original request as a fresh run.

## Agent engines

The same app runs on two different agent SDKs, selected by `ENGINE`, because both are normalized into the same event schema before anything downstream sees them. This is the clean-boundary design paying off — swapping the entire agent engine, across two languages, touches only the runner and the normalizer.

| | Claude Agent SDK (`ENGINE=claude`) | OpenHands SDK (`ENGINE=openhands`, default) |
|---|---|---|
| Language | TypeScript (in-process) | Python (sidecar child process) |
| How it runs | `query()` async generator | `Conversation` + callbacks |
| Sub-agents | `Task` tool, `parent_tool_use_id` | separate `Conversation`s, tagged by id |
| Model | Anthropic only | any LiteLLM model (here: OpenHands proxy) |
| Normalizer | `server/normalize.ts` | the sidecar emits normalized events directly |

**The OpenHands sidecar.** OpenHands ships only a Python SDK, so `server/openhands-runner.ts` spawns `agent/openhands_runner.py` as a child process and exchanges JSON lines over stdio — the same boundary the Claude SDK uses internally (it spawns a `claude` binary). The sidecar emits the exact same `AgentEventBody` objects the Claude normalizer produces, so `ChatSession`, SSE, persistence, the decoder, the UI, and the tests are all unchanged. The orchestration (scope → 2 parallel researchers → analyst → writer) is Python-driven for determinism across models, but **each node is a genuine OpenHands `Agent` + `Conversation`** doing real tool use. The `ask_user` pause lives in the sidecar and resumes when an answer is forwarded to its stdin.

`agent/openhands_runner.py --selftest` emits a scripted run (no LLM) that exercises every normalized event type, used to validate the bridge without spending tokens.

## Tests

```bash
npm test        # 45 tests
npm run typecheck
```

- `tests/decoder.test.ts` — every event type routes correctly; parallel same-type agents stay distinct and don't clobber each other; nested events land on the right node; ask_user suspends/resumes; artifacts dedup; multi-run stacking.
- `tests/fixture-integration.test.ts` — replays all 468 recorded events through the real server normalizer **and** the real client decoder, then asserts the final tree shape, the mid-run parallel state, sequential-after-parallel ordering, and the terminal state. If either side drifts from the shared schema, this fails.
- `tests/normalizer.test.ts` — SDK wire quirks: artifact-path portability across machines, and the `Agent`/`Task` spawn-tool name.
- `tests/persistence.test.ts` — the event log round-trips to disk; `hydrate` continues seq/run bookkeeping; a mid-flight run is finalized as interrupted on restore, a completed one is left untouched.

## The agents

Adapted from [Anthropic's research-agent demo](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/research-agent) (permitted by the assignment), rewritten for markdown deliverables and a deterministic scoping question. Prompts live in `server/prompts/`.

| Agent | Model | Tools | Role |
|---|---|---|---|
| lead (orchestrator) | sonnet | Task, AskUserQuestion | Scopes the request with one question, spawns everything, synthesizes |
| researcher (×2–4, parallel) | haiku | WebSearch, Write | One subtopic each → `files/research_notes/` |
| data-analyst | haiku | Glob, Read, Write | Extracts metrics → `files/data/data_summary.md` |
| report-writer | haiku | Glob, Read, Write | Final brief → `files/reports/research_brief.md` |

## Hard-won SDK findings

Things we hit in real runs that the docs don't tell you (details in [the notes](docs/notes/sdk-event-observations.md)):

1. **`allowedTools` doesn't restrict tools** — it only auto-approves them. The tool surface is set by `tools`, and `settingSources: []` is required to stop the host machine's `~/.claude` plugins from leaking into your agent (our first live run picked up a personally-installed skill and went completely off-pipeline).
2. **Sub-agents can't write report-named markdown.** An undocumented guardrail in the CLI blocks sub-agent `.md` writes whose filename matches `/^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i` — recovered from the binary after the report silently failed to appear. Hence `research_brief.md`.
3. **`forwardSubagentText` + `includePartialMessages`** are off by default; without them the trace has no sub-agent thinking and no live deltas.
4. **The spawn tool is named `Agent` on the wire** in SDK 0.3.x, not `Task` as documented. The normalizer accepts both.
5. **Relative tool paths resolve against the server's cwd**, not the session's — agents occasionally write outside their workspace. We re-anchor paths in `canUseTool`.

## Known limitations

- **Live agent context doesn't survive a server restart.** Persistence preserves the full event history and UI trace, but the SDK child process and its conversation memory are gone. A restored session reattaches a *fresh* runner, so a follow-up message starts a new agent context (in mock mode the replay continues fine).
- One run at a time per session; a second message queues behind the active run.
- Artifact viewer renders markdown and plain text only (by design — the agents are prompted to produce markdown).
- Mock mode ignores your message text — it replays what was recorded.
- ask_user is attributed to the orchestrator; in this agent set only the lead holds the tool, so routing deeper was not needed.
- Persistence is per-process local files (`data/`), not a shared store — fine for a single-machine demo, not for horizontal scale.

## Project layout

```
shared/         event schema + decoder (the contract; framework-free)
server/         normalizer, session/SSE layer, SDK + mock runners, persistence, prompts
client/         React UI (Vite)
tests/          decoder + normalizer + persistence unit tests, full-fixture integration test
fixtures/       recorded SDK runs (mock-mode input, test data)
scripts/        capture + smoke scripts used to record fixtures
docs/           design doc, SDK notes
data/           persisted session event logs (gitignored, created at runtime)
```
