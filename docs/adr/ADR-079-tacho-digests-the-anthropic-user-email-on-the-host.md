# ADR-079: The stored stand-in for a person's address is keyed by the control plane, and the wire keeps its legacy member

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** platform
- **Related:** `docs/specs/tacho/data-model.md` §2.2 (the Anthropic-side
  observations), issue #3072 (the defect this settles), ADR-042 (data planes),
  ADR-043 (runtime excision — evidence arrives through the ledger and the tacho
  seam)

## Context

`tacho_events` carried `anthropic_user_email`: the real, readable address of
the person behind the session, written through from the harness. Every other
column on that table that identifies a person is a digest —
`anthropic_user_id_hash`, `prompt_digest`, `tool_input_digest`,
`hostname_digest`, `os_user_digest` — and the table's own header says bodies
are digested. ClickHouse has no row policy, so the address was the one
plaintext personal identifier an ordinary org-scoped analytics query could read
back out. The same value was on `tacho.sessions.anthropic_user_email` in
Postgres, where RLS applies but the value is still readable.

Nothing read it. It reached exactly one reader — the `anthropicUserEmail` field
on `get_tacho_session`'s output — and no surface in `apps/app` renders it.
`get_tacho_session` has no entry in `apps/app/capability-ui-map.json`. What the
fleet record needs is to tell one person from another and to follow one person
across sessions, not to display an address.

### The first answer was wrong, and the way it was wrong is the point

The first version of this change hashed the address on the host with a
domain-separated SHA-256 and stored that, arguing that the domain prefix made
the value non-reversible. It does not. The prefix is public — it sits in the
source, in this ADR and in the migrations — so the reader in the threat model
computes `sha256(domain ‖ candidate)` for each address in their own staff
directory and compares. An email address carries so little entropy that hashing
one is not a one-way function in practice, whatever is prepended to it. Domain
separation rules out a *generic* precomputed table and a collision with some
other digest of the same address. It does not rule out a targeted guess, and a
targeted guess is exactly what the reader of an org's own telemetry can make.

That argument had already been made correctly elsewhere in this repository and
was misread here. `authorizationFingerprintBucketKey`
(`apps/api/src/middleware/distributed-rate-limit.ts`) domain-separates a
*credential* — a high-entropy secret — to stop one digest doubling as the auth
verifier in a second table with a different access surface. Entropy does the
one-way work there; the domain does a different, smaller job. Copying the shape
without the entropy carried the reasoning into a place it does not hold.

### Removing the wire member was also wrong

The same first version replaced `anthropic.user_email` with
`anthropic.user_email_digest` in the `tacho/1.0` envelope. `anthropicSchema` is
`.strict()` and sits inside a request validator that rejects the whole ingest
batch, so one event from a collector that had not been upgraded would have
taken its batch-mates down with it, and a WAL entry sealed before the change
could never have been sent at all. The wire version stayed `tacho/1.0`, so an
installed host had no signal to upgrade on. Bumping the version would not have
helped: an already-sealed `tacho/1.0` entry is immutable — its hash covers
every member — so it can only ever be offered under the version it was sealed
with.

## Decision

**The stored value is an HMAC, stamped by the control plane.**

`packages/handlers/src/lib/tacho-user-email-digest.ts` computes
`HMAC-SHA256(key, domain ‖ NUL ‖ pre-image)` and writes it as
`hmac-sha256:<64 hex>`. The key is `TACHO_USER_EMAIL_DIGEST_KEY`, held by the
API deployment exactly as `TACHO_ENROLLMENT_SIGNING_SECRET` is, and it reaches
no tenant, no host and no store. A reader of `tacho_events` can guess as many
addresses as they like and confirm none of them.

The prefix is `hmac-sha256:` rather than `sha256:` so the value says out loud
that it is keyed. A reader who sees `sha256:` on a low-entropy input is
entitled to assume they can reverse it; on this column they cannot, and the
value should not invite the attempt.

**The column is server-stamped, not envelope-derived.** It leaves
`ENVELOPE_COLUMNS` and joins `SERVER_STAMPED_COLUMNS` beside `org_id`,
`workspace_id`, `received_at` and `chain_verified`. `flattenEvent` does not
emit it and `WRITABLE_COLUMNS` would drop it if it did. A producer must not be
able to choose this value: one it computed would be either forged or, lacking
the key, reversible.

**Keying happens on the control plane, not the host.** A key on every host is a
key any one host can use to reverse the digest of every colleague in its scope
— strictly more reach than the address in its own WAL, which is that machine's
own user's address on that machine's own disk. A per-workspace key delivered in
the signed enrollment bundle would narrow that blast radius without closing it,
and it would break joins across workspaces and need a rotation path reaching
every installed host. The control plane already holds every other secret on
this path, so keying there adds no new custodian.

**The host still hashes first, and the wire keeps both members.** A collector
from this release on sends `anthropic.user_email_digest`, the published
domain-separated SHA-256 of the normalised address, so the address never
crosses the wire. `anthropic.user_email` stays in the schema, accepted and
never stored, because removing it is an uncoordinated break. The control plane
reduces whichever member arrives to the same pre-image and keys it, so a legacy
collector and a current one produce **one stored value per person** — a fleet
part-way through an upgrade does not split a person in two.

Hashing on the host and keying on the server do different jobs. The first keeps
the address off the wire; the second makes the stored value one-way for the
reader this defect is about. Neither substitutes for the other.

**Nothing is backfilled.** A keyed digest cannot be computed in a migration
without putting the key into a statement and therefore into a query log, and
ClickHouse — which must produce the identical value for the same person — has
no HMAC function to call at all. So both migrations drop the plaintext column
and leave the rows already written without the attribute. That is the stronger
outcome for the defect: the addresses are gone rather than re-encoded. What it
costs is attributing a historical session to a person, which nothing read.

**When the key is absent, no digest is recorded and ingestion continues.** The
attribute is lost and no address is stored — failing closed on the data. The
alternative, refusing the batch, is the same failure shape as the wire break
above: a configuration gap taking a fleet's telemetry down. The first
occurrence per process logs a warning.

## Consequences

The fleet record can still count distinct people and follow one person across
sessions, platform-wide, because the key is one key. It cannot show an operator
who a session belongs to by address, and neither can anyone reading the store.
When a surface needs to name a person it names the Oxagen principal the
enrollment was issued to — an identity Oxagen owns and governs — rather than an
observation the harness happened to emit.

Rotating `TACHO_USER_EMAIL_DIGEST_KEY` re-bases every digest: rows either side
of a rotation stop joining. There is no re-keying path, because re-keying would
need the addresses, which are gone by design. Rotation is therefore a
deliberate break of historical continuity, not a routine hygiene step, and the
env registry entry says so.

The control plane can confirm a guessed address, because it holds the key. A
deployment that wants Oxagen itself unable to do that needs a key Oxagen does
not hold, which means per-workspace keys in the enrollment bundle and the costs
above. That is a product decision rather than a defect, and it is recorded on
the issue rather than settled here.

`get_tacho_session` returns `anthropicUserEmailDigest` where it returned
`anthropicUserEmail` — a contract output rename visible on the API and MCP
surfaces.

Anything else that digests a low-entropy identifier belongs beside this one and
must be keyed for the same reason. `digestUserEmail` in
`packages/tacho/src/digest.ts` carries the warning in its own doc comment so
the next reader does not repeat the mistake this ADR opens with.
