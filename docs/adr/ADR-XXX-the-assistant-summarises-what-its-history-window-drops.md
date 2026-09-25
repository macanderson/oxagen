# ADR-XXX: The assistant summarises the messages its history window drops

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** ADR-053 (the in-app agent runs on `stella-serve`), ADR-021 §2
  (compaction replaces a contiguous prefix with one summary), ADR-131 (a
  model and its key come from one funding source), issue #4171.

## Context

The in-app assistant sends the engine at most 50 prior messages
(`HISTORY_LIMIT`, `packages/agent/src/runtime/assistant-turn.ts`). Before this
record an older message left the turn for good. A cost centre the person gave
in message 3 of a 120-message thread was missing from every turn after
message 52.

ADR-053 lists compaction among the things the engine owns. At the pinned
`stella-serve` 0.9.411 that holds inside one turn and not across a thread:

- A `POST /v1/turns` turn, the route the assistant uses, runs on the messages
  the host sends (`crates/stella-serve/src/routes.rs:59`) under
  `EngineConfig::default()` (`routes.rs:401`). The route passes
  `on_settled: None` (`routes.rs:478`), so the engine drops its rewritten
  transcript when the turn ends (`crates/stella-serve/src/session.rs:108`).
- The engine compacts before a model call once the transcript passes
  `compaction_budget_tokens`, 150,000 estimated tokens by default
  (`crates/stella-core/src/driver/config.rs:401`, `driver.rs:699-714`). Its
  eviction, dedup and ageing passes run first. A model-written summary of the
  oldest span runs only when those passes cannot reach the budget
  (`driver.rs:963-1000`). The assistant sends no compaction overrides.
- Fifty chat messages rarely come near 150,000 tokens. The engine cannot
  summarise a message the host never sent.
- The `/v1/sessions` resource keeps the transcript in the engine and lets
  compaction reach across turns (`crates/stella-serve/src/sessions.rs:5-12`).
  That transcript lives in the engine process.

## Decision

1. **Oxagen summarises what its window drops.** When the messages after the
   stored summary no longer fit the window, the turn folds the previous
   summary and the messages that left the window into one new summary. The
   call runs on the fast tier through `@oxagen/ai`, on the funding source the
   turn already resolved (`selectModelFromFunding`), and is charged as
   assistant tokens. The code is `packages/agent/src/runtime/history-summary.ts`.
2. **One summary per conversation, in Postgres.** It is stored in
   `chat.conversations.history_summary` (JSONB) with the id of the newest
   message it covers. It is derived state of that conversation's Postgres
   rows, replaced when the window moves, and read in the transaction that
   loads the history. So it lives on the row it summarises, under the same
   tenant scope, row-level security and soft delete. It is not agent memory
   (Neo4j), because nothing outside the conversation recalls it. It is not
   an event (ClickHouse), because it is overwritten.
3. **A rewrite leaves room.** A new summary keeps the newest 40 messages word
   for word, and the window grows back to 50 before the next rewrite. A turn
   adds two messages, so one summary serves about five turns, and the history
   prefix the provider caches stays the same between rewrites.
4. **The summary opens the history.** It rides ahead of the window as a
   system-injected context message. It is the first user-role message of the
   transcript, which the engine's own overflow summariser keeps word for word
   (`crates/stella-core/src/driver/restore.rs:137`).
5. **The run says what the turn carried.** Each turn that carries a summary,
   or needed one and could not get it, writes a `context.history_summarized`
   frame before the engine is asked anything: the outcome (`applied`,
   `stale` or `unavailable`), the summary's digest and length, how many
   messages it stands in for, how many the turn carried word for word, and
   whether this turn wrote it. The summary text is the frame's body. The run
   spec's context policy names `conversation_history` as a provider.
6. **The summary never holds a turn hostage.** The call is bounded at 10
   seconds and overlaps the turn's tool, prompt and memory reads. Past the
   bound, or on any failure, the turn runs on the plain 50-message window
   with the previous summary when there is one. The log and the frame both
   say which.

## Alternatives

**Move the assistant to `/v1/sessions`.** Not now. The transcript would live
in the engine process, a restart would lose it, and what the model saw would
depend on state Oxagen does not store. The engine's summariser is also
worded for a coding agent's work log (`crates/stella-core/src/summarize.rs:10`),
not a conversation with a person.

**Send the whole thread.** Rejected. Input cost grows with every turn, and
the engine would decide what survives only once the thread passed 150,000
tokens.

**Summarise on every turn.** Rejected. It costs one fast-tier call per turn on
every long thread and changes the cached prefix on every turn.

## Consequences

- A fact from early in a thread reaches the turn as long as the summariser
  kept it. The summariser is told to keep identifiers, numbers and decisions,
  and the frame's body shows what it kept.
- A long thread pays one fast-tier call about every five turns.
- The summary's tokens are metered and charged as assistant use. They do not
  count against the per-turn budget guard, which reads the engine's
  completions.
- A thread with more than 261 unsummarised messages, which only a thread
  older than this record can have, gets its oldest messages left out of the
  first summary. The summary says so and the log names the conversation.
