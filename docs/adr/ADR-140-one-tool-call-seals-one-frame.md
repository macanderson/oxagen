# ADR-140: One tool call seals one frame, sealed by the source that reports it first

- Status: accepted
- Date: 2026-09-22
- Related: ADR-058 (run record placement and digest-only retention), ADR-100 (frame bodies), ADR-101 (four wrapped harnesses), #3661 (the defect), #3651 (the read-side fold this replaces)

## Context

Tacho hears about a Claude Code tool call from three seams. The PostToolUse hook posts it with the input and the output. Claude Code's OTel exporter posts a `tool_result` log record and a tool span for the same call. The transcript tailer reads the `tool_result` block back out of the session file. All three carry the same `tool_use_id`, and the recorder sealed a `tool_call` frame for each.

One session recorded on 2026-09-21 (WAL session `c60bde3e`, run `tse_9td78h74a4fjx72fa2k2sm`) made nine tool calls and sealed twenty-seven `tool_call` frames. Nine carried the body. Eighteen carried a digest and nothing else.

The cost is in two places. The record says three calls happened where one did, so a reader counting frames counts wrong and `body_frames` over `content_frames` reads as a third of what the host actually captured. Every call also costs three frames of WAL, of shipping, and of ingest.

PR #3651 folded the copies on the Run page. That hid the symptom for one reader. The chain still held three seals, and every other reader of the record still saw them.

`LlmCallLedger` already solved the same problem for model calls, which are also reported by up to three sources. It seals every sighting and stamps the later ones `oxagen.llm_call_duplicate_of`, so the control plane counts the tokens once. That works for a model call because each source carries usage the others do not: the proxy has the wire bytes, OTel has the cost, the transcript has the cache split. A digest-only `tool_call` copy carries no such thing.

## Decision

One `tool_call` frame exists per `tool_use_id` per chain. The first source to report a call seals it. A later sighting of that call from another source seals nothing.

The hook is canonical in practice, because it is synchronous with the call and is the only source that carries the body. The rule is stated as first sighting rather than hook only, so a host enrolled without hooks still records its tool calls, and so a denied call, which the hook never reports as a `tool_call`, is still sealed by the transcript.

The one sighting that still seals is one bringing a body the chain does not hold. A sealed frame cannot be amended, because the chain hash covers every member of it, so a body that arrives after a digest-only frame would otherwise be lost. That frame seals and carries `oxagen.tool_call_duplicate_of` naming the source that reported first, the way `LlmCallLedger` stamps a second sighting of a model call, so a reader counts one call.

The ledger is `ToolCallLedger` in `packages/tacho/src/claude-code/tool-call-dedupe.ts`. It holds up to 1,024 calls per chain, it is part of the recorder state a restart continues from, and it is part of the chain mark a rollback restores, so a session that ends and resumes does not seal a second copy of a call it already holds.

A subagent has its own chain and its own ledger. A `tool_call` with no `tool_use_id`, which is what the MCP gateway seals for a connected client, has nothing to join on and always seals.

## What this loses

A later sighting can carry a fact the sealed frame lacks: OTel's `tool_result_tokens` and `tool_decision_source`, the transcript's `tool_denial_kind` and `parent_tool_use_id`. Those facts are not sealed when the hook reported the call first.

Two alternatives would have kept them, and both are worse.

**Defer the seal until the sources settle.** The recorder would hold a call open until the OTel batch and the transcript poll had reported, then seal one frame carrying everything. The OTel exporter batches on a multi-second interval, so every tool call would sit in memory outside the chain for the length of that interval, and a crash in that window would lose the call outright rather than record it twice. A duplicated frame is a worse record. A missing frame is no record.

**Keep sealing the copies and stamp them, the way model calls are stamped.** That leaves the frame count at three per call and leaves every reader to fold them, which is the state #3651 patched at one reader. The efficiency half of the defect would stay exactly as it is.

The facts that are lost are recoverable at the seam that owns them: `tool_decision_source` is on the `policy_decision` frame the same call's PreToolUse sealed, `tool_denial_kind` reaches a denied call through the transcript's own first sighting, and `tool_result_tokens` is an OTel measurement of an output whose bytes and byte count the hook frame already carries.

One consumer reads a dropped fact. `readTachoToolCallObservations` (`packages/telemetry/src/cost-frames.ts`, read by the findings job under ADR-062) joins the hook row to the `otel_span` row of the same `tool_use_id` for its result tokens, and reports `resultTokens: null` when no span reported them. A Tacho enrollment sets `OTEL_LOGS_EXPORTER` and `OTEL_METRICS_EXPORTER` and no traces exporter, so that join is already empty on a standard host; on a host that exports traces itself, it becomes empty for sessions recorded after this change. Where those result tokens should come from instead is a question for that seam, not for the chain.

## Why durable

The chain's claim is that it holds what happened, once. A seam that reports the same event twice is a property of the harness, not of the record, and absorbing that difference is the recorder's job. The join key is the harness's own `tool_use_id`, which every source already carries and which no future source can report without, so a fourth seam joins the same way the three do today.

## Consequences

- Sessions recorded before this change still hold three frames per call. The read-side fold added by #3651 stays for them. Removing it would misread history.
- `body_frames` over `content_frames` rises to what the host captured, so `body_missing` stops being reported for sessions that missed nothing.
- A witness for the rule is `packages/tacho/src/claude-code/recorder-tool-call.test.ts`.
