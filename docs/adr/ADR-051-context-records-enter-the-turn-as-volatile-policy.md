# ADR-051: A workspace's context records enter the turn as volatile policy, not as prefix

- **Status:** Accepted
- **Date:** 2026-09-08
- **Owners:** platform
- **Related:** issue #2592 (records stored and never applied), issue #2580 (the
  registry that stores them), ADR-039,
  `packages/agent-engine/src/ports.ts` (`SteeringProvider`),
  `packages/agent/src/runtime/steering-records.ts`,
  `packages/agent-runner/src/stella/run-stella-turn.ts`

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
