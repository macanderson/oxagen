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
that independently write the same fact produce the same ID, which deduplicates
the record. Everything outside the hash can still differ between them.

`mergeRecordMetadata` merged three of those fields (salience, confidence,
causality) and took every other one from whichever record was passed as `local`:

```ts
return { record: { ...local, salience, confidence, causality }, conflict };
```

So `merge(a, b)` and `merge(b, a)` disagreed on `provenance`, `createdAt`, `ttl`
and `lastReinforcedAt`. Its doc comment said "the result is independent of
argument order (convergent)" throughout.

`recordVersionDigest` — the value the
Merkle tree compares to decide whether two peers differ — covered the same three
merged fields. Two records differing only in provenance, creation time or expiry
produced an identical digest, so the diff reported them as already in agreement
and never asked the merge to reconcile them. Because the digest missed the same fields the
merge got wrong, the peers stayed split permanently.

`crdt-props.test.ts` already
asserted commutativity, associativity and idempotence over `mergeRecordSets`.
Its generator varied only the three merged fields, and its normalizer compared
only those three plus the ID — so the property was asserted only over the
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

Each rule is commutative, associative and idempotent, so the merge converges.

`ttl` takes the longest: a memory the two peers disagree about is kept. Losing one is the worse failure, and eviction is a
local policy that runs again anyway.

The digest is hashed rather than returned raw, because it now carries the
embedding and an inline vector would grow every Merkle leaf by its length.

## What this gives up

**`provenance` picks a winner.** Under content addressing two agents can both
author the same record, and after a merge one of them is no longer credited. The
system's stated purpose is auditable memory.

A grow-only set of contributors would credit every author. It did not ship
because nothing today reads a second contributor. The upgrade is additive when a reader exists —
add `contributors`, union it, put it in the digest, and leave `provenance` as
the deterministic pick so existing readers keep working.

Until then the rule is stated and the same on both peers, so both peers drop the
same author; without it each side could drop a different one permanently.

## Consequences

- The first sync after this lands reconciles every record once, because the
  digest changed for all of them. The merge is convergent, so it settles in one
  pass.
- `crdt-props.test.ts` now varies every divergent field and compares the whole
  record. It fails on the previous `merge.ts`.
- A field added to `MemoryRecord` in future needs a row in the table above, a
  rule in `mergeRecordMetadata`, an entry in `recordVersionDigest`, and a
  variation in the property test's generator. Three of those four are silent if
  skipped — the property test only fails if the generator varies the field.
