# ADR-095: The tier ladder is four words, computed from what was routed

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform, app
- **Decided by:** the maintainer, 2026-09-18, approving the architecture review
  of the same date in full
- **Related:** ADR-078 (wrapped and connected; amended here), ADR-040 §4
  (attestation versus gateway enforcement), ADR-056 (delivery modes per tier),
  ADR-067 (every claim states its scope), ADR-094 (the gateway), ADR-096 (the
  contained tier), the Tacho spec's `enforcement_tier` field and honesty rule
- **Delivered by:** Phase 4 (`gateway` gains model traffic and is computed from
  routing), Phase 5 (`contained` is added). The vocabulary rule applies now

## Context

Checked at `main` `02278c913`.

`ENFORCEMENT_TIERS` in `packages/tacho/src/envelope.ts:63` is
`["gateway", "harness", "observe"]`. ADR-078 gave the three values product
words: **wrapped** is `harness`, **connected** is `gateway`, and `observe` is
what a wrapped host reports in observe-only mode. It fixed two things: no fourth
value is minted, and neither tier dominates the other, because wrapped is
broader and client-attested while connected is narrower and server-enforced.

Two things changed. ADR-094 routes a wrapped harness's model and MCP traffic
through `tachod`, so `gateway` stops meaning only "an Oxagen MCP server in a
connected app's config". And ADR-096 adds a tier ADR-078 had no word for.

The tier is also assigned today, not computed: `packages/tacho/src/wire.ts`
maps a harness name to a tier (`"claude-desktop": "gateway"`). A host with a
proxy installed and a harness that went around it would still be labelled by
what was installed.

The tier's failure mode needs stating exactly, because the code and the word
"fail-open" look like they disagree. The command hook fails closed against its
cached bundle: in enforce mode a stale or unverified bundle denies non-read-only
tools (`packages/tacho/src/host/bundle.ts`, `hook-handler.ts`). The tier as a
whole is fail-open against the person at the keyboard: remove the hook entry,
disable hooks or run another build of the harness, and the action proceeds.
"Fail-open" below describes the tier, not the hook process.

## Decision

The tier ladder, four words, computed from what was actually routed:
**observe -> harness -> gateway -> contained.**

| Word | What it means | What it may claim | What it may not claim |
|---|---|---|---|
| `observe` | Recorded only | "recorded" | Anything about refusal or delivery |
| `harness` | Hooks installed; steering is delivered and the four blocking hook events can refuse, client-attested and fail-open | "delivered", "recorded", "client-attested", "fail-open" | "enforced". Never |
| `gateway` | Model and MCP traffic routed through `tachod`; metering observed, budgets enforced | "observed" metering, "enforced" budgets on routed traffic | "enforced" against the machine's operator; anything about traffic that was not routed |
| `contained` | The agent runs under an OS sandbox whose only egress is the gateway | "enforced". This is the only tier that earns the word against the machine's operator | Anything about a run that was not launched by the launcher |

A control claim always carries its scope: "for actions routed through Oxagen".

**Computed, not assigned.** A run's tier is derived from the traffic the record
shows: hook events give `harness`; model and MCP requests seen by the gateway
for that run give `gateway`; a launcher attestation plus gateway-only egress
gives `contained`. What was installed on the host is not evidence of what a run
did.

**Today.** Agents sit on `observe` or `harness`, and Claude Desktop sits on
`gateway` for its Oxagen MCP calls only. `gateway` for a wrapped harness arrives
with Phase 4 and `contained` with Phase 5. Until then a surface shows them as
tiers not yet available and claims no model proxy, observed metering, enforced
budget, real interrupt or sandbox as present.

## What this changes in ADR-078, and what it keeps

- **Changed, §1:** "No fourth value is minted." `contained` is the fourth.
- **Changed, §1:** `gateway` is no longer only the connected tier. It is any
  run whose model or MCP traffic was routed through `tachod`. A connected app
  with no hook surface is on `gateway` for the calls that routed and is
  invisible otherwise, exactly as ADR-078 §5 says.
- **Kept, §2:** breadth and certainty are different things. For a wrapped
  harness the ladder is cumulative, since each rung adds a seam to the ones
  below. For a connected app it is not: `gateway` there has no `harness` rung
  under it. So a tier word is never rendered as a score, a percentage or "fully
  governed", and every surface still states what the tier records and what it
  does not.
- **Kept, §3 to §6** unchanged: the routed-around property, the proxy is not a
  second materialiser, the ledger table, both tiers on one machine.

## Consequences

- `ENFORCEMENT_TIERS` gains `contained` in Phase 5, as a wire-compatible
  addition. The denormalised column on the run row and the ClickHouse column
  take the new value without a rename.
- The honesty rule in the Tacho spec widens by one line: "enforced" is allowed
  for budgets on `gateway` traffic and for `contained`, and nowhere else.
- Copy that says "enforced on every call" with no scope is already banned by
  the brand word list. This ADR is the engineering reason.
- ADR-056's delivery modes follow the ladder: `interrupt` degrades at `harness`
  and is real at `gateway`.

## Supersedes and amends

Amends ADR-078 §1 as above. ADR-078 stays Accepted, with a status note pointing
here.

## Alternatives considered

**Keep three values and call the proxy tier `harness`.** Rejected. Observed
metering and an enforced budget are a different claim from a client-attested
hook, and one word for both would force every surface to under-claim or lie.

**Assign the tier at enrollment.** Rejected. Enrollment records intent. A run
that bypassed the proxy would inherit a word it did not earn.

**Drop `observe` and fold it into `harness`.** Rejected. A host in observe-only
mode delivers nothing and can refuse nothing, and the record must say so.

**A numeric score instead of words.** Rejected under ADR-078 §2.
