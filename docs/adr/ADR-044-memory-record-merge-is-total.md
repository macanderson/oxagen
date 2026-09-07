# ADR-044: Every field of a memory record has a merge rule

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #1388 (memory sync is not convergent, and the Merkle digest
  cannot see the fields that diverge), issue #1367 (`lastReinforcedAt`, added
  after #1388 was written and divergent in the same way),
  `packages/engram/src/sync/merge.ts` (`mergeRecordMetadata`,
  `recordVersionDigest`), `packages/engram/src/sync/protocol.ts` (`syncWithPeer`,
  the caller), ADR-041 (canonical JSON, which the tie-breaks here rely on)

## Context

A memory record's ID is a content hash of kind, namespace and body. Two peers
that independently write the same fact produce the same ID — that dedup is the
feature. Everything outside the hash can still differ between them.

`mergeRecordMetadata` merged three of those fields (salience, confidence,
causality) and took every other one from whichever record was passed as `local`:

```ts
return { record: { ...local, salience, confidence, causality }, conflict };
```

So `merge(a, b)` and `merge(b, a)` disagreed on `provenance`, `createdAt`, `ttl`
and `lastReinforcedAt`. Its doc comment said "the result is independent of
argument order (convergent)" throughout.

**The detector could not see it either.** `recordVersionDigest` — the value the
Merkle tree compares to decide whether two peers differ — covered the same three
merged fields. Two records differing only in provenance, creation time or expiry
produced an identical digest, so the diff reported them as already in agreement
and never asked the merge to reconcile them. Both halves failed in the same
direction, which is what turned an ordering wrinkle into a permanent split.

**Two tests should have caught it and could not.** `crdt-props.test.ts` already
asserted commutativity, associativity and idempotence over `mergeRecordSets`.
Its generator varied only the three merged fields, and its normalizer compared
only those three plus the ID — so the property was asserted over exactly the
subset that already converged. A generator that does not vary a field, and a
normalizer that does not compare it, together make a property test that cannot
fail on it.

## Decision

Every field of a `MemoryRecord` is either merged by a stated rule or provably
identical for a given ID, and `recordVersionDigest` covers every field in the
first group.

| field | rule | why |
| --- | --- | --- |
| `id`, `kind`, `namespace`, `body` | not merged | the ID is their content hash, so two records sharing an ID share all four |
| `salience`, `confidence` | max | bounded [0,1] score; max is a join over a totally-ordered bounded lattice |
| `causality` | set union | grow-only set of DAG edges |
| `createdAt` | min | the earliest observation is when the fact was first known; a later peer writing the same content did not create it again |
| `ttl` | longest, absent wins | absent means never expires, so it is the top of the lattice |
| `lastReinforcedAt` | latest, absent loses | absent means never reinforced, so it is the bottom; a retrieval on either peer really happened |
| `provenance` | earliest `timestamp`, canonical tie-break | see below |
| `embedding` | present beats absent, canonical tie-break | the ID does not cover the embedding model, so two peers can hold different vectors for one fact |

Each rule is commutative, associative and idempotent, which is what makes the
convergence claim hold rather than merely be repeated.

`ttl` takes the longest rather than the shortest deliberately: a memory the two
peers disagree about is kept. Losing one is the worse failure, and eviction is a
local policy that runs again anyway.

The digest is hashed rather than returned raw, because it now carries the
embedding and an inline vector would grow every Merkle leaf by its length.

## What this gives up

**`provenance` picks a winner, and that is a real loss.** Content addressing
means two agents genuinely authored the record, and after a merge one of them is
no longer credited — in a system whose stated purpose is auditable memory.

A grow-only set of contributors is the more honest model. It is not what shipped
here for one reason: nothing today reads a second contributor, and a field no
reader consults is scaffolding. The upgrade is additive when a reader exists —
add `contributors`, union it, put it in the digest, and leave `provenance` as
the deterministic pick so existing readers keep working.

Until then the rule is at least *stated*, and the same on both peers, which is
the difference between losing an author predictably and losing a different one
on each side forever.

## Consequences

- The first sync after this lands reconciles every record once, because the
  digest changed for all of them. That is a cost, not a fault: the merge is
  convergent, so it settles in one pass.
- `crdt-props.test.ts` now varies every divergent field and compares the whole
  record. It fails on the previous `merge.ts`, which is what makes it a witness
  rather than a restatement.
- A field added to `MemoryRecord` in future needs a row in the table above, a
  rule in `mergeRecordMetadata`, an entry in `recordVersionDigest`, and a
  variation in the property test's generator. Three of those four are silent if
  skipped — the property test only fails if the generator varies the field.
