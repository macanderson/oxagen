# ADR-195: A run's reads cover every chain it recorded

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** runs, evidence
- **Related:** issue #3823, issue #3822 (the transcript splices subagent
  chains), issue #4083 (a late subagent frame on a live run), ADR-182 (one
  composition of a run's frames), ADR-058 (the run recorder capabilities).

## Context

A wrapped run's subagents each record on a hash chain of their own: their own
`session_uuid`, their own dense `seq` from 0, their own `tacho.sessions` row,
their own checkpoints and their own seal. `root_session_uuid` names the run
each chain belongs to. #3822 made `get_run_transcript` read every chain and
splice each subagent chain in after the `subagent_start` that spawned it.
Every other reader of a wrapped run still read the root chain alone, by `seq`.
Because a subagent chain also numbers from 0, a `seq` on its own could name a
frame on either chain.

Two facts about the stores shape the choices below. Ingest commits the
Postgres session row, `seq_count` included, before it inserts the frame into
ClickHouse (`tacho.events.ingest.ts`). A head read from Postgres can therefore
name a frame no read returns yet. And ClickHouse sorts a UUID by its last
eight bytes first, so the order it returns chains in is not the order they
started in.

## Decision

1. **A subagent frame is named by its chain and its seq together.** Every
   reader that answers a frame from a subagent chain carries the chain's
   `sessionUuid` beside the `seq`: `get_run` frames, `get_run_frame_body`
   input, `get_run_outputs` nodes, `bisect_runs`' `divergentSessionUuid`, and
   the transcript's halves and entries. A frame on the run's own chain carries
   none, so every existing `seq` keeps its meaning.
2. **`get_run` pages one chain.** `sessionUuid` names a subagent chain, which
   must be one Postgres lists under the run's root. Any other chain, and any
   chain on a ledger run, is `not_found` with reason `chain_not_found`. A
   frame cursor on the run's own chain stays `f:<seq>`, and one on a subagent
   chain is `f:<session uuid>:<seq>`. A cursor minted on another chain than
   the one read is refused as an invalid cursor. `decodeFrameCursor` keeps its
   root-only answer for the transcript's frame cursor and the stream, and
   `decodeFramePosition` reads both forms.
3. **`get_run` answers every subagent chain's head, read from ClickHouse.**
   Postgres lists the chains once per invoke, and ClickHouse answers each
   one's `max(seq)` (`selectTachoChainHeads`, fenced by `root_session_uuid`),
   so a head names a frame a read can return. `chains.cursor` is `h:` and 16
   hex characters of a sha256 over `<uuid>:<lastSeq>` lines for the chains
   that hold a readable frame. It fits the 64-character `chainsAfter` field
   at any number of chains, and a chain that is only registered does not move
   it. With `chainsAfter` and `waitMs`, each tick of the long poll reads the
   heads again and returns when the digest changes. A chain that starts during
   a wait is spawned by a frame on a chain already listed, which ends the wait
   itself, so the list is not read again on each tick.
4. **The run stream carries the heads.** `run.stream.ts` writes
   `event: chains` when the stream opens and whenever the heads cursor moves,
   passes the last cursor it wrote as `chainsAfter`, and renews its idle
   deadline on a move. The Run page reads the transcript's tail on a moved
   head as it does on a frame. A run where only a subagent is still recording
   now keeps the stream awake.
5. **`get_run_chain` walks each subagent chain on its own.** Gaps computed
   over frames spliced from several chains would mean nothing, so each chain
   is answered in `chains` with its gaps on its own `seq`, its checkpoints
   read by its session row id in one query, and its seal. The chains' frames
   are one read of up to `CHAIN_FRAME_CAP` rows beside the run's own chain.
   ClickHouse answers a chain's rows together, so when that read is cut, the
   chain the cut fell in and every listed chain that returned no frame are
   marked incomplete, whatever order the store returned them in. The
   top-level figures keep describing the run's own chain.
6. **A subagent's gaps are gaps in the run's record.** The ladder counts a
   sequence gap on any subagent chain as `chain_break` and a missing body
   there as `body_missing`, and it counts a subagent's retained bodies toward
   `view`.
7. **Bisect and the account read what the Run page shows.** `bisect_runs`
   reads each run through `readRunChains`, every recorded frame kept, under
   one cap over all chains. `run.enrich`, the job behind `summarize_run`,
   reads `readTranscriptFramesOf`, the composition the transcript folds
   (ADR-182), and the root-only `readRunFrames` is removed.
8. **Each subagent chain is one more attempt in an export.** Its
   `attempt_id` is the chain's session uuid, its tier, gaps and grade come
   from its own session row, and its manifest entry carries a `chain` block.
   Both verifiers already start the link and the sequence over at each
   attempt, and the recorder opens every chain at genesis
   (`recorder.ts`, `GENESIS_CURSOR`), so a subagent chain verifies from
   `sha256("")` at its own seq 0. The bundle format stays
   `oxagen.run-export/3`, since a reader of format 3 already walks attempts.
   A chain with no stored frame has nothing to attest and is left out.
9. **`fork_run` needs no change.** It refuses a wrapped run by name
   (`fork_requires_ledger_run`), and only a wrapped run records subagent
   chains.
10. **The transcript's cursor carries a receipt (#4083).** A subagent chain
    numbers from 0, so a frame it records after a read can fold before that
    read's cursor, where the cursor's positions cannot call it new. A live
    reader was not sent it until the run sealed. The cursor now also carries
    the receipt time (`tacho_events.received_at`) through which the reader
    was sent every frame, and how many entries of the next batch it already
    holds, since the server stamps one receipt time on a whole batch. An
    entry at or before the cursor with a frame received after the receipt is
    sent again, after the grown entries and before the new ones. The receipt
    trails the read by a settle margin of 10 seconds (`RECEIPT_SETTLE_MS`),
    because ingest commits the session row in Postgres before it inserts the
    frame into ClickHouse. The one-frame and two-frame cursors still decode.
11. **A read from a transcript cursor reads a window of the run (#3823).**
    The cursor names the frame on the run's own chain that opens the latest
    turn the reader was sent, with the run's turn and cumulative cost there.
    The next read starts at that frame and holds every chain spawned inside
    the window, so a page no longer reads the run again from frame 0. A read
    falls back to the whole run when only the whole run can place a chain:
    one that began before the window and has recorded since the receipt, one
    the cursor names, or one that names a spawn the window lacks. `counts`
    and `figures` ride only the read from the run's first frame, and the Run
    page keeps that read's counts on every chip (decision D6 of #3823). A
    read with `query` is not windowed and searches the run up to the frame
    cap.

## Consequences

- A subagent frame can be opened, linked, paged, bisected and exported like a
  frame on the run's own chain.
- A live wrapped run costs one more ClickHouse aggregate per poll tick while a
  reader waits with `chainsAfter`, and one Postgres listing per invoke. The
  aggregate reads only the listed chains' primary-key ranges.
- The heads cursor is a digest, so a reader cannot tell from it which chain
  moved. It reads `chains.heads` for that, or reads the transcript's tail.
- Postgres lists at most 200 chains on `get_run` and on `get_run_chain`, and
  each says so with `complete: false`. The export lists every chain.
- A subagent chain that ingest registered and never wrote to reads as a head
  with no `lastSeq`, a chain with no frames and no gaps, and no export
  attempt.
- A live reader is sent a late subagent entry on the first tail read after
  its receipt, with no reload. An entry with a frame received inside the
  settle margin is sent again on each read until the margin passes it, and
  the reader replaces the copy it holds.
- A reader of a long run pages past frame 10 000, because each page reads a
  window. A subagent chain that began before the window and keeps recording
  sends every read back to the whole run until it stops.
- The chips keep the first read's whole-run counts until the page reads the
  run again, so on a live run they trail the tail.
- A reader holding a cursor written before the receipt is not sent a late
  subagent frame the server received before its next read. The page shows
  that frame once it reads the run again, as it did before this change.

## Alternatives rejected

- **A per-chain high-water mark in each cursor.** A chain key is about 45
  characters and `framesAfter` is capped at 256, so the cursor would stop
  fitting at five chains and grow with every subagent. The digest has a fixed
  size and the heads travel beside it.
- **Heads from Postgres `seq_count`.** It moves before the frame is readable,
  so a reader woken by it would read nothing and wait again.
- **One walk over the spliced frames on `get_run_chain`.** Each chain starts
  at 0, so the spliced sequence has no dense order to find gaps in.
- **A new export format.** Attempts already carry their own link and
  sequence rules in both verifiers, so an attempt per chain needs no new
  shape. The `chain` block is additive, and the verifiers do not read the
  manifest strictly.
- **A transcript read of the whole run on every page.** It places a late
  frame with no receipt, but every page costs a read from frame 0, and a run
  past 10 000 frames never pages past the cap.
- **Counts over a window.** They would be the window's and not the run's, so
  each chip would renumber from page to page.
- **A receipt with no settle margin.** A read taken between the Postgres
  commit and the ClickHouse insert would move the receipt past a frame it
  never read, and that frame would never be sent.
