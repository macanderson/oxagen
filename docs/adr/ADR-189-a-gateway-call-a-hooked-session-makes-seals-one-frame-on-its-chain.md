# ADR-189: A gateway call a hooked session makes seals one frame on that session's chain

Status: Accepted
Date: 2026-09-25
Owners: platform
Amends: ADR-140 (one tool call seals one frame), the sentence "A `tool_call` with no `tool_use_id`, which is what the MCP gateway seals for a connected client, has nothing to join on and always seals"
Related: #3944 (G-11 in the 2026-09-23 Tacho audit), ADR-078 (the local MCP gateway), ADR-095 (the tier ladder), ADR-168 (one ledger per session family)

## Context

The local MCP gateway seals each `tools/call` it forwards as a `tool_call` frame on the daemon's own chain, with no `tool_use_id`. ADR-140 accepted that: the frame has nothing to join on, so it always seals.

That fits Claude Desktop, which has no hooks and no session. It does not fit a hooked harness that uses the gateway as one of its MCP servers. Claude Code with the gateway added to its MCP servers recorded each such call twice. The gateway sealed a `tool_call` on the daemon's chain, and the `PostToolUse` hook sealed another on the session's chain. The two frames named one call under two identities, on two chains, and nothing joined them. The session's own record also showed no sign that Oxagen served the call.

Claude Code names the call in every MCP `tools/call` request it sends, under `params._meta["claudecode/toolUseId"]`. The 2.1.283 binary spreads that key into the request's `_meta`. The call reaches the gateway after its `PreToolUse` and before its `PostToolUse`, because Claude Code waits on the hook before it calls the tool, and waits on the tool before it sends the `PostToolUse`.

## Decision

1. The gateway reads `params._meta["claudecode/toolUseId"]` from a `tools/call` and hands it to the daemon with the call. It forwards the request unchanged. It ignores an id that is not a string of 1 to 512 characters, the length the envelope accepts.
2. A `PreToolUse` that seals a `tool_requested` frame claims the call's `tool_use_id` in the session family's `ToolCallLedger`, the way a subagent's hooks already claim its calls. The claim registers no sighting.
3. When a gateway call names an id that a live session has claimed and no source has sealed yet, the daemon seals the gateway's frame on that session's chain, or on the chain of the subagent that made the call. The frame carries the `tool_use_id`, the gateway's body and digests, and `oxagen.enforcement_tier: gateway`. The ledger judges it as the `gateway` source. It is the first sighting, so the `PostToolUse`, OTel, and transcript sightings of the same call seal nothing.
4. A call the control plane refused seals its `policy_decision` on that chain with the `tool_use_id`. A refusal is not a sighting of the call, so the hook's `PostToolUseFailure` then seals the call's one `tool_call` beside it.
5. The daemon seals a session's gateway frame on its serial queue, where that session's hooks are handled, without holding the client's answer for it. The frame lands before the call's `PostToolUse`, because the queue runs in order and the harness sends that hook only after the answer. A failed write is logged and rolled back, which leaves the call claimed, so the `PostToolUse` seals it instead.
6. A gateway call whose id no live session is waiting on seals on the daemon's chain, as before. That covers a client that sends no id, a session without hooks, and a second call naming an id the session already holds, which the ledger would otherwise judge a repeat and drop.

ADR-140's rule, as ADR-168 widened it, now reads: one `tool_call` frame per `tool_use_id` per session family, sealed by whichever of the hook, the OTel export, the transcript tailer, or the gateway reports the call first.

## What this loses

The surviving frame is the gateway's, so it differs from the frame the hook would have sealed:

- It names the tool as the gateway knows it (`tool_name: query_ontology`, `mcp_server_name: oxagen`), not as the harness does (`mcp__<server>__query_ontology`, under whatever server name you gave the gateway). The `tool_requested` frame of the same `tool_use_id` keeps the harness's name.
- It carries none of the hook's classification: `effect_kind`, `tool_is_mutating`, `effect_id`. The `network` effect frame the `PostToolUse` seals for an MCP call still carries `effect_id`.
- Its output digest covers the JSON-RPC result the control plane sent, not Claude Code's `tool_response`.

Letting the hook's frame win instead would keep those facts and drop the gateway's evidence from the session's record: that Oxagen served the call and could have refused it. That fact is the reason the gateway tier exists.

## Consequences

- The forwarded request still names the daemon's chain in `x-tacho-gateway-session`. The control plane files its record of the call against that chain, and the session that made the call gains no `gateway` tier from it. Naming the session's chain instead would change that session's tier under ADR-095, which needs a decision of its own.
- The id is the client's word. The gateway takes no credential from a local client, so a local process that sends the id of a call a session is waiting on puts its frame on that session's chain, and the hook's report of the real call then seals nothing. The process has to name the id between that call's `PreToolUse` and its `PostToolUse`. ADR-095 makes no claim against the machine's operator, and this stays inside that limit.
- Tacho writes the gateway's MCP entry only into Claude Desktop's configuration today. This applies once you add the gateway to a hooked harness yourself.
- Sessions recorded before this change keep both frames.
- A call whose `PreToolUse` has not been handled when the gateway answers still seals twice. The hook client gives a `PreToolUse` 10 seconds, then spools it and answers, and Claude Code calls the tool while the live request still waits in the daemon's queue. No session has claimed the id yet, so the gateway frame seals on the daemon's chain under decision 6, and the hook's `tool_call` seals on the session's chain. #4355 carries the fix.
- The witness is `packages/tacho/src/collector/daemon-bodies.test.ts`: a hooked session's `PreToolUse`, its gateway call, and its `PostToolUse` seal one `tool_call`, on the session's chain. A second test fails the gateway frame's write and finds the `PostToolUse` sealing that one `tool_call` instead (decision 5). `packages/tacho/src/claude-code/recorder-tool-call.test.ts` covers the subagent chain, the refusal, and the claim across a restart and a rollback.
