# SDK Event Stream Observations (Phase 0)

Source: `fixtures/run-001.jsonl` — real run of the ported research agent on
`@anthropic-ai/claude-agent-sdk` 0.3.173, captured 2026-06-11.

## Options that matter (set on `query()`)

| Option | Why we need it |
|--------|----------------|
| `forwardSubagentText: true` | Without it, sub-agent text/thinking blocks are NOT in the stream — only tool_use/tool_result. With it, the full nested transcript arrives, each message stamped with `parent_tool_use_id`. |
| `includePartialMessages: true` | Emits `stream_event` deltas (text/thinking as it generates) — needed for live typing effect and "never idle" chat. |
| `includeHookEvents: true` | Hook firings appear in the stream as `system/hook_started` / `hook_response` — we may not need them; our own hooks + lifecycle events cover it. |
| `canUseTool` callback | The ask_user mechanism. Blocks the agent until we resolve with `{behavior:"allow", updatedInput:{questions, answers}}`. Stream stays open. |
| `agents: {...}` | Programmatic AgentDefinition map — no .claude dir needed. |

## Agent context routing (the core decode insight)

- Every `assistant`/`user` message carries `parent_tool_use_id: string | null`.
  - `null` → lead agent (orchestrator).
  - Otherwise → the `id` of the `Task` tool_use block that spawned the sub-agent.
- Messages ALSO carry `subagent_type` ("researcher") and `task_description` — labels for free.
- **Tree node identity = the Task block's `tool_use_id`.** Two parallel researchers
  appeared as `toolu_01TGBJ…` and `toolu_01ScT7…`, messages interleaved — same
  agent type, distinct nodes. Never key by agent name.

## Sub-agent lifecycle events (in-stream, no hooks needed)

- `system/task_started` — `{task_id, tool_use_id, description, subagent_type, prompt}`.
  This is the spawn event: maps tool_use_id → agent identity.
- `system/task_progress` — periodic heartbeat per task (carries elapsed info).
- Completion: the `user` message containing the `tool_result` for the Task's
  `tool_use_id` (also `PostToolUse` hook / `SubagentStop` hook fire).
- `tool_progress` messages: `{tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds}` — activity ticker material.

## ask_user flow (observed end-to-end)

1. Lead emits `assistant` message with `tool_use` block `AskUserQuestion`
   (input: `{questions:[{question, header, options:[{label, description}], multiSelect}]}`).
2. SDK invokes `canUseTool("AskUserQuestion", input)` — server-side promise; we
   surface to browser, wait for answer.
3. Resolve with `updatedInput: {questions, answers: {[question]: label}}`.
4. Tool result flows back as a `user` message; lead resumes.

## Misc observed

- `system/init` — session start: session_id, model, tools, agents list, permissionMode. Render immediately ("no early feedback" pitfall).
- `rate_limit_event` — subscription five-hour window status; surfaced when close to cap.
- `SDKAssistantMessage.error` field enumerates API errors (rate_limit, overloaded, billing…) — feed error states.
- Hook callbacks: `SubagentStart`/`SubagentStop` exist as in-process hooks with `agent_id` == `task_id`.
- Auth: SDK works via Claude CLI keychain OAuth — no ANTHROPIC_API_KEY required.
- npx is rewritten by the local rtk hook — invoke `./node_modules/.bin/tsx` directly.

## result message (from run-002-mini.jsonl)

`{type:"result", subtype:"success"|"error_*", is_error, duration_ms, num_turns,
result: string, stop_reason, session_id, total_cost_usd, usage:{input_tokens,
output_tokens, server_tool_use:{web_search_requests}, ...}}` — maps to our
`done` event; `result` is the final answer text, usage/cost feed a run summary.

## Live-run finding (2026-06-12): settings leakage

First live run through the full stack went off-pipeline: the lead invoked the
host machine's personal `deep-research` skill via Skill/Workflow tools instead
of spawning our researchers. Two SDK facts behind it:

- `allowedTools` only AUTO-APPROVES tools; it does not restrict availability.
  The base tool surface is set by `tools: string[]`.
- `settingSources` defaults to loading ALL of the host's `~/.claude` settings
  (plugins, skills, commands). `settingSources: []` = SDK isolation mode.

Fix: both options set in server/agent-runner.ts. The decoder rendered the
foreign agent/tools fine (nothing hardcoded) — failure was config, not decode.

## Open questions / risks

- Subscription rate limits (`overageStatus: rejected, out_of_credits`) — budget
  real runs; develop against the fixture replay.
- run-001 truncated at seq 389 (report-writer mid-flight): the background
  process was killed externally — NOT an SDK failure. Fixture still covers all
  event types except report-writer's Task tool_result and the final result
  message (shape captured separately in run-002-mini.jsonl).
- Sub-agent cwd quirk: report-writer ran a Glob that returned project-root
  files rather than workspace files — pin agent prompts to absolute paths or
  verify cwd inheritance in our backend.
