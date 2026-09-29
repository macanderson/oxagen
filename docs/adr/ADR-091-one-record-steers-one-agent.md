# ADR-091: One record steers one agent — steering rides the bundle's `context.system`

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform
- **Related:** issue #2592 (records stored and never applied), ADR-051
  (superseded delivery), ADR-093 and ADR-144 (the assembler), ADR-061 §8 (the steering version is the ledger
  length), ADR-043 (runtime excision), `docs/specs/tacho/spec.md` §7.5,
  `oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md` §10.4,
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

#### Amendment 2026-09-21: one exempted proposal column

The freeze is narrowed, not lifted. The proof is still outstanding, #2592 is
still open, and everything §6 names still waits on it.

What is exempted: `context_proposals.title`, an optional nullable column added
by PR #3645. The test §6 means to apply is the sentence that gives its reason —
"every one of them would add process to a record that did not yet reach an
agent" — not the word "fields" read on its own. This column adds no process.
Nothing gates on it, no check reads it, it opens no state, it adds no review
step and no ledger action, and a proposal with a null title behaves exactly as
every proposal does today. It labels a proposal that already exists.

Read in code at the merge commit: a merge copies it into the record's
classification (`context.steering.store.ts`, `title: proposal.title ??
proposal.statement`) and the Steering views display it. It stops there.
`compileSteering`'s `describe` renders the statement, the kind and the lineage
slug (`lib/tacho-steering.ts`), so a title never reaches `context.system` and
never reaches an agent. The Context PR is titled from the lineage slug, not
from this column, so it does not move a review either.

So §6's list is read by its purpose: a proposal field that adds process is
frozen, and a proposal field that only names an existing proposal is not. A
field anything decides on is ceremony and stays frozen.

This is an owner's override, made by Mac on 2026-09-21 with the proof still
outstanding, and recorded here and on #2592 rather than taken quietly. It
exempts one column. The next change that touches governance ceremony gets the
freeze as written, and the freeze still lifts only on the #2592 proof.

## Amendment 2026-09-29: the delivery path as built

This amendment brings §1, §2, §4 and the Consequences in line with the code at
`main` on 2026-09-29. The decision stands. Active `must` and `should` records
reach every enrolled host through `context.system`. What changed is how the
text is built. §6 and its 2026-09-21 amendment are unchanged.

**The assembler replaced the compiler (§1).** `compileSteering` no longer
exists. `readWorkspaceSteering` (`packages/handlers/src/lib/tacho-steering.ts`)
reads the rows through `packages/agent/src/runtime/published-steering.ts` and
hands them to the assembler in `packages/steering-assembler/src/assemble.ts`
(ADR-093, ADR-144). The row filter is the one §1 names, with one change: every
force is read. The assembler delivers only `must` and `should`. A `may` or
`info` record appears in the signed manifest as cut for its tier, so the
record shows it reached no agent. §3 still holds.

**Records are ordered by recency (§2).** ADR-144 replaced slug order. The
assembler puts `must` before `should`, then the most recently activated record
first, then by slug. The text is still deterministic in the set of
records, so the etag still moves only when a record changes.

**The budget is 8,000 characters (§4).** The host still rejects a `context.system` longer than 16,384
characters. Claude Code reads less: it replaces any `additionalContext` past
10,000 characters with a file path and a preview. So the budget is
`CONTEXT_SYSTEM_BUDGET_TOKENS`, 2,000 budget tokens (`ceil(utf8_bytes / 4)`),
which is at most 8,000 characters (PR #4065). The assembler no longer stops at
the first record that does not fit. It skips that record, tries the next, and
ends the text with a line that says how many records it left out. A short
`should` record can therefore be delivered while a longer `must` record is
cut. The manifest marks each skipped record with the reason `budget`.

**The manifest and the start event carry the proof (§6).** A host that
advertises the `steering_manifest` feature receives `context.manifest` on the
bundle. Its `text_digest` is `sha256:` followed by the hex SHA-256 of the UTF-8
text. The collector seals `oxagen.context_digest` on the `SessionStart` event
with the same formula over the same string. The proof §6 asks for is those two
values being equal on one real run, for a bundle whose text includes a merged
record.

**The cache key covers each record's content (Consequences).** The compiled
text is cached per plane and workspace. The key is the promotions ledger
length, the count of active pinned records of any force, and an MD5 over each
such record's id, pinned version and classification. A record edited in place
therefore moves the key even when the ledger length and the count do not.

**The control envelope announces the etag the host is served (§2).** A host
with skills is served a bundle whose etag is a digest of the policy and the
skills together. Until 2026-09-29 the control envelope announced the policy
etag alone. The daemon compared the two, found them different, refetched, got
`not_modified`, and asked again on its next poll, so a new text for a skills
host waited behind that loop. `servedBundleEtag` in
`packages/handlers/src/lib/tacho-host.ts` now builds both. `get_tacho_bundle`,
the command fetch and the event ingest read the skills before they build the
envelope, outside the tenant transaction, so the envelope names the etag
`get_tacho_bundle` would serve.

**A replayed start names the text the client delivered (§6).** When the
daemon is down, `tacho-hook` answers `SessionStart` from its cached bundle and
spools the event. The spool now records the digest and the length of the text
the client handed the agent. A replay seals that digest, not the daemon's
current one, because the bundle may have changed in between. A spool written
before this change carries no digest, and its replay seals neither attribute.
The manifest frame is sealed on a replay only when its `text_digest` equals
the delivered digest. A missing digest means the text cannot be checked. It
does not mean the text differed.

**A refused start names no text (§6).** A start the collector refuses, such
as one on a suspended host, hands the agent nothing. It seals
`oxagen.delivered_chars` as `0` and no `oxagen.context_digest`, so a refused
run cannot stand as the proof.

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
