# ADR-171: A chain break is reported beside a run's facts

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Related:** ADR-058 (the seal grades a session), ADR-064 (proof verdicts),
  issues #4106 and #4108.

## Context

Ingest checks every batch a host sends against the session's recorded chain
head (`packages/handlers/src/tacho.events.ingest.ts`). When a batch does not
link, it records the break on the session row (`tacho.sessions.chain_verified
= false`) and stamps that frame and every later frame of the session
`chain_verified = false` in `tacho_events`. A break never refuses the batch,
so the frames still land.

The six reads behind the Run page's checkout strip, subagent chips, pull
request receipts, captured diffs, title and effort (`lib/run-work.ts`) kept
only `chain_verified = true` frames. One break therefore hid every fact the
host recorded after it, for the rest of the run. Run
`tse_4scg43cnrvwcnv24fwpfsx` broke at seq 36971, which followed 12051. Every
checkout, subagent, pull request link and title it recorded past that point
read as never captured. The transcript on the same page reads frames without
that filter, so the header contradicted the transcript beneath it.

The chain proves one thing: no frame between genesis and the head was
dropped, reordered or altered after the host wrote it. It does not prove who
wrote a frame. The host's ingest key does that, and ingest refuses a session
that belongs to another host. A frame past a break is as much the host's own
record as a frame before it. What the break loses is the proof that nothing
between the two is missing.

## Decision

1. **A read of what the host recorded reads every accepted frame.** The six
   reads in `lib/run-work.ts` take no `chain_verified` predicate. They serve
   `get_run_work`, `get_run_outputs` and the title and effort in `get_run`.
2. **The break is reported beside the facts.** `get_run_work` adds the
   `chain_break` warning, and so answers `complete: false`, when the session
   row reads `chain_verified = false`. A sealed run also carries `chain_break`
   in its completeness gaps, as it already did.
3. **A claim of what Oxagen proves still needs an unbroken chain.** The
   gateway enforcement tier (ingest) and the steering delivery report
   (`packages/telemetry/src/steering-deliveries.ts`) keep their
   `chain_verified` conditions. They state what the record proves, not what
   the host said.
4. **A frame's `chain_verified` keeps its meaning.** It reads true only while
   the frame links back to genesis without a gap. Ingest does not restart
   verification after a break.

## Alternatives considered

- **Keep the filter.** The page then prints "not captured" for facts the
  store holds. That statement is false, and it is the one an auditor reads.
- **A `verified` flag on each checkout, subagent, diff and link.** It is more
  precise for a fact recorded before the break. It changes the contract and
  every consumer, and a consumer can already tell the run's chain broke from
  the warning. The session row does not record where the chain broke, so the
  flag would need that column first. A later decision can add both if a
  consumer needs them.
- **Restart verification at a break**, so frames past it read verified
  against the segment they start. That changes what `chain_verified` means
  for stored rows, needs a backfill of every broken session, and weakens the
  one claim the flag makes. Rejected.

## Consequences

- The checkout strip, subagent chips, pull request receipts, captured diffs,
  title and effort include what the host recorded after a break.
- An API or MCP caller sees `chain_break` in `get_run_work` whenever the
  chain broke, live or sealed.
- The Run page does not yet mark a live run's break. Completeness gaps are
  published only once a run seals, and the app does not render
  `get_run_work` warnings. The warning is there for it to read.
- A new read of `tacho_events` decides which of the two kinds it is. A read of
  what the host recorded takes no `chain_verified` filter. A read behind a
  claim of proof keeps it.
