# ADR-051: A workspace's context records enter the turn as volatile policy, not as prefix

- **Status:** Superseded by ADR-043; amended 2026-09-18 by ADR-093 and ADR-094 (where its injection path re-lands, see the amendment at the end)
- **Date:** 2026-09-08
- **Owners:** platform
- **Related:** issue #2592 (records stored and never applied), issue #2580 (the
  registry that stores them), ADR-039,
  `packages/agent-engine/src/ports.ts` (`SteeringProvider`),
  `packages/agent/src/runtime/steering-records.ts`,
  `packages/agent-runner/src/stella/run-stella-turn.ts`


> **Superseded on 2026-09-08 by ADR-043 (runtime excision).** ADR-043 removed
> `packages/agent-engine` (and with it the `SteeringProvider` port),
> `run-stella-turn.ts`, and `packages/agent/src/runtime/turn-driver.ts` — the
> whole in-repo turn assembly this ADR wires into. `steering-records.ts` was
> deleted with them: it implemented a port that no longer exists and had no
> other caller.
>
> What survives is the storage half: context records are still published,
> promoted, versioned and listed (`context.record.*` routes, the MCP tool, the
> handlers and the `agent_asset` schema all remain). What is gone is the path
> that reads them *into a turn*, because Oxagen no longer runs turns — Stella
> does. Re-landing this behaviour belongs on the governed tool gateway seam,
> and **issue #2592 should be reopened against it** rather than left closed by
> a mechanism this repo no longer contains.

## Context

The agent-asset registry gave a workspace somewhere to publish its steering
policy — context records, versioned, with a hash-chained promotion ledger.
Nothing read them into a turn. A workspace could publish a record, promote it,
and no agent run behaved differently.

`runStellaTurn` assembles a turn from the system prompt, history, the
instruction and the tool schemas. Recalled memory rides history as a volatile
message. Context records rode nothing.

Three questions had to be answered before any of it could be wired, and #2592
asked them rather than assuming: where the records enter, which records apply,
and who owns a record that carries an enforcement grant.

## Decision

### They enter as a volatile message, not in the system prefix

Immediately after the cached system block, as `user`, before recalled memory and
before the instruction — the same position recalled memory already occupies, for
the same reason.

The system prefix is a prompt-cache contract. Records differ per workspace, so
putting them there fragments the cache across every workspace on the platform.
Records change at human speed, so a per-workspace prefix would mostly hit — but
"mostly" is not an argument you can make about a cache key, and the steer from
one message before the instruction is strong enough.

**Steering before memory.** Policy is what the model should read first; recalled
memory is the more specific, more recent thing to be holding when it reaches the
instruction.

### Every active record applies

Not a subset chosen by surface or capability. A finer rule would need scope to
be a stored field and it is not one — the registry stores a slug, a title, a
status and a body. Filtering on something the record does not carry means
inferring intent from a title, which works until somebody renames a record.

A record with no pinned active version is skipped rather than rendered empty: a
heading with no body steers nothing and costs tokens.

When records grow a scope field, `loadActiveSteeringRecords` is the one function
that changes.

### Enforcement belongs to the decision-rules engine, not to this

A promoted record may carry an enforcement grant. This layer puts its text in
front of the model and does nothing else. The two must not both govern the same
action: a denial that depends on which layer ran first is not a policy, it is a
race.

## Consequences

- A turn on a workspace with published records carries one more message. On a
  workspace with none the transcript is byte-identical to before, which is what
  the cache argument depends on and what a test pins.
- The engine never learns what a context record is. `SteeringProvider` returns
  pre-formatted text, exactly like `MemoryProvider.recallContext`, so the
  vocabulary lives in the host and the placement lives in the engine.
- A registry read failure surfaces as a `steering-load` non-fatal and the turn
  runs unsteered. That is the only thing separating "the registry was
  unreachable" from "the workspace published nothing", and those two looking
  identical is the silence #2592 was filed about.
- The platform's durable-run driver passes the provider. Other hosts —
  `chat.stream`, the A2A bridge — do not yet, so a turn through them is still
  unsteered. The port is optional, so that is a wiring gap rather than a
  behaviour change, and it is named here so it is not mistaken for a decision.

## Amendment 2026-09-18: where this ADR's injection path re-lands

Maintainer decision of 2026-09-18, recorded in ADR-091, ADR-093 and ADR-094.

The supersession note says re-landing "belongs on the governed tool gateway
seam". The changed sentence: **this ADR's injection path re-lands at the Phase 0
seam, and later per turn at the proxy.**

- **Phase 0 (ADR-091, in review as PR #3289).** Active `must` and `should`
  records compile into the signed bundle's `context.system`, which the collector
  hands the harness at `SessionStart`. That is a stable prefix, not the volatile
  message this ADR chose, because a hook-tier host has no per-turn seam to carry
  one.
- **Phase 1 (ADR-093).** The volatile selection (`may` and `info` items, picked
  per prompt under a token budget) rides `UserPromptSubmit`, which receives the
  prompt.
- **Phase 4 (ADR-094).** Per-turn volatile injection re-lands at the loopback
  model proxy, which is the closest thing to the turn this ADR was written for.

The scope and enforcement decisions in this ADR carry over as ADR-091 §5 states
them, until ADR-092's enforcement grant lands in Phase 1.
