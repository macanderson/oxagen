# ADR-166: A session and its subagents share one model-call ledger and one tool-call ledger

Status: Accepted
Date: 2026-09-24
Owners: platform
Amends: ADR-140 (one tool call seals one frame), the sentence "A subagent has its own chain and its own ledger"
Related: #3944 (chargeback proof), #3661, [docs/specs/tacho/spec.md](../specs/tacho/spec.md)

## Context

Tacho records a Claude Code subagent on a chain of its own, beside its parent's. Each chain kept its own `LlmCallLedger` and its own `ToolCallLedger`, so a call was judged a duplicate only against sightings on the same chain.

A subagent's call does not stay on one chain. The loopback proxy seals a subagent's model call on the root session, because it correlates by the harness session id and the subagent shares it with its parent. The subagent's transcript, read on `SubagentStop`, seals the same call on the child chain. An OTel record that carries no `agent_id` seals on whichever chain `agent.name` routes it to. Each ledger saw the call first, so each chain counted its tokens.

With the proxy, OTel, and the transcript all reporting, a subagent's model call counted three times. Without the proxy it counted twice. Two parallel subagents of one type made it worse: `childByType` resolved an OTel record that names only the type to the subagent opened last, so the first subagent's records were sealed on its sibling's chain. A subagent's tool call had the same shape. Its PostToolUse hook sealed on the child chain and an OTel `tool_result` with no `agent_id` sealed on the root.

Run cost sums the counted rows by `root_session_uuid`, so the overcount reached every run total, every cost-center statement, and every chargeback line that read a session with subagents.

## Decision

1. One `LlmCallLedger` and one `ToolCallLedger` serve a session and all of its subagents. The root recorder owns both. A child recorder judges each sighting against the root's ledgers and holds no ledger of its own. It looks the ledger up on each sighting, because the root replaces its ledgers on a rollback.
2. The root's recorder state and chain mark carry the family's ledgers. A child's state carries empty ones. A restart that restores a child state written by an older build moves that child's ledger entries into the root's, and a key the root already holds keeps the root's entry.
3. An OTel record that names only an agent type routes to a subagent of that type only when exactly one is open. When two or more are open, the record seals on the parent chain.
4. ADR-140's rule now reads per session family: one `tool_call` frame per `tool_use_id` across a session and its subagents.

## Consequences

- A subagent's model call that the proxy saw first counts on the root chain. Its transcript rows on the child chain are stamped `oxagen.llm_call_duplicate_of` and add no tokens. Run cost is unchanged by where the counted row sits, since it sums by root. The Run header shows subagents as chips with no cost of their own, so no reader loses a number.
- The ledger capacities (8,192 model-call keys, 1,024 tool calls) now cover the whole family. Parallel subagents fill them faster than one chain did.
- The fix applies to calls sealed after a host upgrades. Rows an older build already shipped stay unstamped, and the totals that read them stay high. Nothing on the host can repair a sealed row.
- The witness is `packages/tacho/src/claude-code/recorder-subagent-count.test.ts`: one parent with two parallel subagents of one type counts each model call and each tool call once.
