# ADR-262: A Codex rollout seals one llm_call per completed response

- **Status:** Accepted. The agent building lane tacho-codex-rollout chose
  this under SCR-002. Mac has not ruled on it.
- **Date:** 2026-10-02
- **Owners:** tacho
- **Related:** issue #3824 (item 1, the Codex half), PR #5153, ADR-231,
  ADR-256 (amended: the duplicate rule), `packages/tacho/src/codex/rollout.ts`,
  `packages/tacho/src/collector/transcript-tailer.ts`,
  `packages/tacho/src/claude-code/llm-call-dedupe.ts`,
  `packages/tacho/fixtures/codex/transcript/`.

## Context

Codex writes each thread to a rollout file under `~/.codex/sessions/`, one
JSON record per line. Every Codex hook names that file as `transcript_path`.
Tacho's tailer read only Claude Code transcripts, and #3822 made it skip
Codex sessions, because nothing could read a rollout.

So a Codex run had a model call frame only when the call went through the
gateway. A run that bypassed the gateway had no model calls on its record:
no usage, and no assistant text between the prompt and the turn's end.

A rollout spreads one model response over several lines. Codex writes each
item as it finishes: `reasoning`, an assistant `message` with `output_text`,
a `function_call` or `custom_tool_call`. When the response completes, it
writes one `token_usage_record` with the response id (`resp_…`) and the
response's usage. The text and the id are on different lines.

The rules below come from 263 rollouts written by Codex 0.150 to 0.159.2 on
one host, read on 2026-10-02:

- In 2,465 responses, an assistant message and the usage record that closed
  its response had only these lines between them: `reasoning`,
  `function_call`, `custom_tool_call`, `item_completed`,
  `thread_settings_applied` and `realtime_item`.
- 56 messages had no usage record of their own. In every one, a
  `token_count` event came before the next response's record. In 51 of them,
  an inter-agent message had cut the response short.
- 16,633 of the 19,089 responses wrote no text. They asked for a tool and
  stopped.
- 100 usage records came with no item before them. Each was a compaction
  call, and a `compacted` line followed it.
- Rollouts imported from another agent hold thousands of assistant messages
  and no usage records. A forked subagent's rollout starts with its parent's
  history, usage records included, and `session_meta` says where that copy
  ends (`subagent_history_start_ordinal`).

## Decision

1. **Reader.** `codex/rollout.ts` reads a rollout. The recorder picks it when
   the session's harness is `codex`, and the tailer now reads Codex
   sessions. The ADR-231 bounds hold: the tick reads outside the hook
   queues, at most 4 MiB from a file and 16 MiB in all. `Stop` and
   `SubagentStop` drain in the hook's queue, as they do for Claude Code.
2. **One frame per completed response.** A `token_usage_record` closes the
   response and seals one `llm_call` with source `transcript`. Its body:
   - `provider` from the file's first `session_meta`, and `model` from the
     latest `turn_context`;
   - `message_id`, the record's `response_id`;
   - the usage, folded the way the proxy folds an OpenAI usage block:
     `input_tokens` without the cached part, `cache_read_tokens` from
     `cached_input_tokens`, `cache_creation_tokens` from
     `cache_write_input_tokens`, `output_tokens`, and `thinking_tokens` from
     `reasoning_output_tokens`.

   The frame names the record's `turn_id`, and its `raw_source_digest` is
   the digest of the usage record.
3. **Body.** The body is the response's `output_text` blocks, then each tool
   request as one `{"tool_use":{"id","name","input"}}` line. This is the
   body Claude Code's reader writes for an assistant message
   (`assistantMessageText`). Reasoning is left out, as thinking is. The
   reader seals no prompt, tool call or tool result frame, because hooks
   record those. A response that wrote nothing visible gets an empty body:
   one that wrote only reasoning, or a compaction call. Codex writes a
   compaction call's usage record, then a `compacted` line whose summary is
   encrypted, and no item between them. A body longer than
   `TACHO_MAX_BODY_BYTES` is not held, and the frame carries
   `body_omitted: too_large`. A response whose text was dropped (decision
   4) gets no body, so the frame shows the gap.
4. **What drops a response's text.** The reader drops the text it holds, and
   counts it in `orphaned`, when one of these comes before a usage record: a
   `token_count` event, `task_started`, `task_complete`, `turn_aborted`, a
   `turn_context`, or `compacted`. It also drops text whose items named a
   different turn than the usage record. If Codex changes the order it
   writes in, the reader loses bodies. It never puts one response's text on
   another response's frame, and it never counts a call twice.
5. **Copied history.** Lines whose `ordinal` is below the first
   `session_meta`'s `subagent_history_start_ordinal` seal nothing.
6. **Unknown records.** A record type the reader does not know is skipped and
   counted in `unknown`, by type, for at most 16 types.
7. **State.** The reader's state (provider, model, history start, the
   response in hand, the two counts) is plain JSON on the file's tail cursor
   (`FileCursor.codex`). It persists with the offset, resets when the file is
   replaced, and reopens with the cursor when a session resumes. It moves
   past a line whether or not the line seals, as the offset does. No second
   state file exists.
8. **One call, one count.** The gateway's `llm_call` for a Responses API call
   stores `response.id` as `message_id`. The rollout frame carries the same
   id, so the model call ledger stamps it `oxagen.llm_call_duplicate_of:
   collector`, and readers count the call once. A rollout frame for a call
   the ledger already holds from the rollout is a line read twice, and it
   seals nothing. Claude Code's reader seals a continuation block there,
   because one Claude Code message spans several records. A Codex response
   is one record.
9. **Subagents.** Codex sends a spawned subagent's own rollout as
   `transcript_path` on every hook that subagent fires except
   `SubagentStop`, under the root session's id. That path no longer replaces
   the session's transcript. The daemon opens a subagent cursor on it, fed
   with the subagent id, and `SubagentStop` drains it from
   `agent_transcript_path`.

## Why

- **Why the usage record closes a response.** It is the only line with the
  response id, and the id is the join key with the gateway's frame. Text
  sealed when its message line arrived would have no key, and a call that
  went through the gateway would count twice.
- **Why tool requests go in the body.** An `llm_call` that is the first
  sighting of its call owes a body (`frameOwesBody`). Most responses wrote
  no text, so a text-only body would leave most frames without one, and
  every Codex session that bypassed the gateway would grade `inspect`.
- **Why `token_count` ends a response.** In the measured rollouts it never
  came between a message and its own usage record. It came first in every
  case where the message had no record.
- **Why stamp and not skip.** The ledger stamps a later sighting from every
  other source the same way. The stamped frame keeps the response as Codex
  recorded it, beside the proxy's wire bytes.
- **Why the cursor holds the state.** The cursor already persists one file's
  position. State kept anywhere else could disagree with the offset after a
  crash, and the next line would close the wrong response.

## Consequences

- When a host upgrades, each live Codex session's rollout is read from byte
  0. Its earlier responses seal after the frames already on the chain, and a
  response the gateway sealed is stamped its duplicate. A sealed session gets
  a drained cursor and is not read, as for Claude Code.
- Ingest counts a self-reported `llm_call` only until a session has an
  observed one (`usageCountedEvents`), so the totals of a session that went
  through the gateway do not change.
- The tail state file shows how the reader is doing: `unknown` names record
  types a newer Codex added, and `orphaned` counts responses whose text
  dropped.
- Cursor transcripts still have no reader. That needs a real Cursor
  transcript with assistant messages, which needs a Cursor account in good
  standing.

## Alternatives considered

- **Seal each message when it arrives, with no usage.** Rejected. It has no
  join key, so a proxied call would count as two model calls, and the
  frame would carry no usage for a call that bypassed the gateway.
- **Match a message to its response by id prefix.** The item ids and the
  response id share a prefix and look ordered. Rejected, because Codex does
  not document it.
- **Skip the rollout frame when the gateway sealed the call.** Rejected for
  the reason under "Why stamp and not skip".
- **Keep the reader's state in its own file.** Rejected for the reason under
  "Why the cursor holds the state".
