# ADR-104: A harness label round-trips whatever it holds

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform
- **Related:** #3103, #3098, #3102; `docs/specs/tacho/`; `packages/tacho/src/envelope.ts`
- **Delivered by:** `packages/handlers/src/skill.list.ts` (`namesQuery`,
  `nameRowSchema`, `toInventoryRow`), `packages/oxagen/src/contracts/skill.list.ts`
  (`skillInventoryRowSchema.harnesses`, `harnessCount`, `SKILL_HARNESS_CAP`),
  `apps/app/src/data/contracts/skills.ts`

## Context

`list_skills` groups a workspace's reported skill names and, for each, the
distinct harnesses of the sessions that reported it. The aggregation joined
those harnesses with a newline delimiter and split them back apart on read.
`agent.harness` is `z.string().max(512)` at the wire
(`packages/tacho/src/envelope.ts`) — length-bounded only. A label containing a
newline split into invented labels the page then displayed as if a harness had
reported the skill when it had not. An empty label failed `nameRowSchema` and
`toInventoryRow` threw, which failed the whole page's read for every viewer in
that workspace until the session aged out of the window — one session's
recorded label could take down a shared read. #3103 filed this on the
maintainer for a decision: tighten the wire schema so `agent.harness` must be
non-empty, or relax the read side to carry whatever was recorded.

## Decision

**Loosen the read side. The wire schema is unchanged.**

`agent.harness` stays `z.string().max(512)` — no new minimum length, no new
character restriction. `ingest_tacho_events` is a deployed ingestion path;
tightening it would start refusing session reports from wrapped harnesses
already running in the field, on data this contract already accepted, to fix a
defect in a read three hops downstream. That is not a fix, it is moving a
five-year-old acceptance surface to solve a read bug, and it is not
reversible for the sessions it drops on the way.

The read is fixed at its one true fault: the newline-delimited aggregate. A
harness label is never guaranteed newline-free, so no delimiter character can
safely join a set of them. `namesQuery` now aggregates with `jsonb_agg`, which
carries each string byte-for-byte with no join character to collide with. An
empty label is a value this contract already recorded; it round-trips as `""`
rather than being rejected. `skillInventoryRowSchema.harnesses` drops the
per-item `.min(1)` that made an empty label reject the row — the array itself
still requires at least one entry, since a reported skill has at least one
session with at least one harness value, empty or not.

The unbounded-aggregation concern raised in review of #3102 is the same fix
site, so it rides this decision too. `SKILL_HARNESS_CAP` (20) bounds how many
distinct harnesses one skill row returns; `harnessCount` on the row carries the
true distinct count past that cap, so a workspace whose wrapper stamps a
unique label per session cannot make one row's payload grow without bound, and
nothing above the cap is silently dropped without a trace of how much was cut.

## Consequences

- A harness label containing a newline, or any other character, round-trips
  exactly what was recorded. The Skills page never shows a label no session
  actually reported.
- No single session's harness value can fail the read for the rest of a
  workspace. An empty label shows as an empty label, not a crash.
- `skillInventoryRowSchema`, the app's `SkillInventory` view model, and
  `docs/capabilities/skill.list.md` / `schemas/list_skills.json` all carry the
  new `harnessCount` field and the loosened `harnesses` item type. A consumer
  of the contract's TypeScript types picks this up at the type level; nothing
  silently narrows.
- `agent.harness` remains exactly as permissive as it always was. This ADR
  makes no promise about what a harness *should* send — only that whatever it
  does send is preserved, not guessed at, by the one read that reports it back.
- Rendering an empty harness label legibly in `apps/app/src/features/skills/
  sections.tsx` (e.g. a placeholder chip) is UI polish outside `list_skills`'
  files and is not this decision's scope; the empty string reaching the
  component unrejected is.

## Alternatives rejected

**Tighten `agent.harness` to a non-empty, delimiter-free string at the wire.**
Rejected: an already-deployed ingestion contract would start refusing data
from wrapped harnesses already running, to fix a bug in a downstream read.
Data loss for a read-side defect is the wrong trade, and no matter how the
character set were restricted, the wire schema does not decide what a display
read is allowed to show — the read owns that.

**Keep `string_agg` but pick a delimiter unlikely to appear in a harness
label.** Any delimiter is still a value `agent.harness` is permitted to send;
"unlikely" is not "impossible," and the same failure mode returns the day a
harness sends it. `jsonb_agg` removes the delimiter, not the odds of hitting
it.

**Leave the aggregate unbounded and accept the memory/response-size risk.**
Rejected per the #3102 review comment: a wrapper that stamps a distinct label
per session can grow one row without bound over a 90-day window, in Postgres
memory, on every read.
