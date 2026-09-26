# ADR-191: A wrapped run's turn steps are counted by the fold's rules in SQL

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** app, evidence
- **Amends:** ADR-182 (its consequence that the wrapped path of
  `get_run_turns` keeps a second definition of a step until each frame
  carries its step key from ingest).
- **Related:** issue #4308, issue #4067 (the per-turn ledger), issue #4351
  (a reply in several blocks), ADR-140 (one tool call seals one frame).

## Context

`get_run_turns` answers a run's per-turn ledger for the Cost tab. For a
ledger run it counts steps with the one step fold in `@oxagen/run-ledger`
(ADR-182). For a wrapped run it counts them in ClickHouse
(`selectTachoTurnGroups`), because a wrapped run can pass 250,000 frames and
the fold reads at most 10,000 (#4067). A query cannot call a TypeScript fold.

The query paired the halves of a tool call with no call id by count: the
larger of the unkeyed requests and the unkeyed receipts. The fold pairs a
request only with the receipt of its own spelling that follows it with
nothing but gates between (rule 3). So a request, a model call, and a
receipt drew as two tool steps on the Transcript tab and counted as one on
the Cost tab, and so did a request and a receipt with Claude Code's own
permission check between them.

ADR-182 left this as a second definition of a step, to be removed by
stamping each frame with its step key at ingest. That stamp depends on the
frames around each one and on the order they arrive in. A frame that arrives
late can change a key already stamped, so the stamp would need a second pass
at seal and a backfill for every row written before it.

## Decision

1. **The fold cannot serve the wrapped path, so the query counts by the
   fold's rules.** Keyed tool calls stay one per call id per chain and turn.
   An unkeyed tool call is rule 3 read from each chain's frames in seq order:
   the query writes one letter per frame, a request as the capital of its
   spelling, its receipt as the lowercase letter, a gate as `-`, and anything
   else as `_`, and counts the matches of `A-*a`. Requests and receipts that
   match nothing are a call each. A gate and any other frame are written
   outside `a` to `z`, so neither reads as a receipt at any number of
   spellings up to 26.
2. **The vocabulary has one home.** `UNKEYED_TOOL_PAIRING` in
   `@oxagen/run-ledger` holds rule 3's request and receipt spellings and its
   gates, derived from the tables the fold itself reads (`TOOL_CLOSE`,
   `TOOL_GATE`). The handler passes it to the query, so a kind added to the
   fold reaches the query without an edit there.
3. **The query reads the frames the fold reads.** A later sighting of a model
   call is left out of the letters, as the fold hides it before it pairs. A
   `policy_decision` the OTel adapter sealed for Claude Code's own check is
   not a gate, as the fold reads it as `harness_permission`.
4. **One test holds the two together.** `run.turns.get.integration.test.ts`
   answers a wrapped run through the query and through the fold over the same
   frames, and asserts they agree, with unkeyed tool calls adjacent, apart
   around a model call, apart around a harness check in its own kind and in
   its legacy OTel spelling, through a gate, and around a hidden sighting.
5. **No step key at ingest.** `tacho_events` gains no column for this.

## Consequences

- The Cost tab and the Transcript tab count the same unkeyed tool calls.
- The query no longer counts `model.request` and `model.response`. They are
  not kinds of the `tacho/1.0` envelope, so no wrapped frame carries them.
- The query and the fold still differ on these frames between an unkeyed
  request and its receipt. Each is named here rather than modelled.
  - A subagent chain that no spawn frame names began between them. The query
    reads a chain's frames in seq order, and the fold reads them in the order
    the transcript splices them.
  - A later sighting with a richer body replaces the first one between them.
  - A later sighting whose first sighting is not among the run's frames sits
    between them. The fold keeps it, as the only copy of the call, and the
    query leaves it out.
  - A transcript reply's further block sits between them. The fold keeps the
    block when the reply's first block stays, so the request and the receipt
    are two calls, and the query leaves it out and pairs them.
    `run.turns.get.integration.test.ts` holds this difference, and #4351
    decides it with the model step half below.
- A transcript reply in two content blocks is two model steps in the fold
  and one model call in the query. That is a separate decision about what a
  step is, and #4351 carries it.
- The query holds each group's letters in memory while it counts: one byte
  and one seq per frame, a few megabytes for the largest run.
