# ADR-091: One record steers one agent — steering rides the bundle's `context.system`

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform
- **Related:** issue #2592 (records stored and never applied), ADR-051
  (superseded delivery), ADR-061 §8 (the steering version is the ledger
  length), ADR-043 (runtime excision), `docs/specs/tacho/spec.md` §7.5,
  `docs/specs/mission-control/spec.md` §10.4,
  `packages/handlers/src/lib/tacho-steering.ts`

## Context

A workspace can propose a context record, open a Context PR, run six checks
on it, merge it under a governance mode, and write a hash-chained promotion
event. None of that changed what an agent did. The policy bundle every
enrolled host fetches carried `context: { system: null }`, hard-coded, and
ADR-051's turn injection went with the runtime ADR-043 removed. The
governance around a record kept growing while the record itself reached
nothing.

The host side was already built. The collector hands `bundle.context.system`
to Claude Code at `SessionStart` (and after `compact`) as `additionalContext`,
and chains its digest into the run. Only the control plane was missing.

## Decision

### 1. Active `must` and `should` records compile into `context.system`

`unsignedBundle` takes the workspace's compiled steering as a required
argument. `readWorkspaceSteering` reads `agent.context_records` rows that are
`active`, not deleted, have a pinned active version and have a `force` of
`must` or `should`, and `compileSteering` renders them as plain text: a
one-line header, then a `MUST` section and a `SHOULD` section, one line per
record giving its statement, its kind (and effect for a constraint) and its
lineage slug. All three bundle builders use it: `get_tacho_bundle`, the
control envelope's etag, and the initial bundle signed at enrollment.

The argument is required, not defaulted, so a new caller that builds a bundle
without steering fails to compile. A caller silently dropping the records is
the defect #2592 was filed about.

### 2. No new version machinery

The bundle etag is a digest of the bundle's content, and the text is now
part of that content. A merge, retire or supersede changes the text, so it
changes the etag, the control envelope announces it on the next poll and the
host refetches. The steering version stays what ADR-061 §8 made it, the
ledger length. Nothing new is counted.

The text is deterministic in the set of records: `must` before `should`,
then by slug, whatever order the rows come back in. An etag that moved with
the database's row order would make every host refetch an unchanged bundle.

### 3. `may` and `info` stay out

The one channel that reaches every session carries what the workspace
requires. `may` and `info` records inform. Spec §10.4 selects them by
relevance, and that selection belongs to context frames, not to this block.

### 4. The host's limit is respected by leaving whole records out

The host parses the bundle `.strict()` and caps `context.system` at 16,384
characters. A longer string would make it reject the whole bundle and keep
its old mandate. The compiler adds records in print order until the next one
would not fit, then states how many it left out. `should` records go first
because they print last.

### 5. Every active record applies, and enforcement stays with the rules engine

This is ADR-051's scope and enforcement decision, unchanged. The registry has
no scope field to filter on, so every active record applies to every host in
the workspace. A constraint record puts its text in front of the agent and
nothing else. A denial belongs to the decision-rules engine.

### 6. Governance ceremony is frozen until this is live

No new governance ceremony lands until this change is deployed and a merged
record shows up in a real run's `agent_start`. That covers new checks, new
governance modes, new ledger actions, new proposal states or fields, and new
review steps. Every one of them would add process to a record that did not
yet reach an agent. Fixes to existing ceremony are not ceremony.

The freeze lifts when the proof is recorded on #2592.

## Consequences

- A workspace with no steering records gets the bundle it had before,
  byte for byte: `context.system` stays `null` and the etag does not move.
- On a workspace with records, every enrolled host refetches its bundle once
  after each merge. Bundles are small and records change when a person
  merges one, so the cost is negligible.
- The text is compiled from the classification each record's pinned version
  carries, not from the record row's copy, so promoting an older version
  back into service changes what the bundle says. Every control poll and
  event ingest carries the bundle etag, so the compiled text is cached per
  workspace and keyed on the workspace's steering version (the promotions
  ledger length, ADR-061 section 8, plus the count of pinned records that
  steer). One `count(*)` per response decides whether the records are read
  again.
- A registry read failure fails the bundle fetch, as a deny-generation or
  retention read failure already does. A host keeps the mandate it has. It
  does not receive a bundle that looks unsteered but is not.
- ADR-051's delivery (a volatile message in a turn Oxagen assembled) is
  superseded here. It had no turn to enter after ADR-043. #2592 is reopened
  against this seam, as ADR-051's supersession note asks.
- Hosts that are not Claude Code get the text only when their adapter injects
  `context.system`. The Agent SDK adapter is the next consumer to check.
