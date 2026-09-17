# ADR-084: The person behind a Tacho session is a principal Oxagen issues, and nothing derived from the reported address is stored

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** platform
- **Related:** `docs/specs/tacho/data-model.md` §2.2, issue #3072 (the defect
  this settles), issue #3186 (deploy ships ahead of its migration), ADR-042
  (data planes), ADR-043 (runtime excision)

## Context

`tacho_events` carried `anthropic_user_email`: the readable address of the
person behind the session, written through from the harness. Every other column
on that table that identifies a person is a digest, and ClickHouse has no row
policy, so the address was the one plaintext personal identifier an ordinary
org-scoped analytics query could read back. The same value sat on
`tacho.sessions.anthropic_user_email` in Postgres.

Getting to the right answer took three wrong ones, and each is worth keeping,
because each is a shape that will be proposed again.

### First: a domain-separated hash

Hash the address on the host with a published domain prefix and store that. The
prefix is public, so the reader in the threat model takes their own staff
directory, computes `sha256(domain ‖ candidate)` for each address and compares.
An email carries too little entropy for a hash of one to be a one-way function
in practice. Domain separation rules out a generic precomputed table and
nothing else.

The construction had been copied from `authorizationFingerprintBucketKey`
(`apps/api/src/middleware/distributed-rate-limit.ts`), where it is correct —
there it domain-separates a *credential*, a high-entropy secret, so entropy
does the one-way work and the domain does a smaller job. The shape travelled to
a place the reasoning does not hold.

### Second: removing the member from the wire

The same round replaced `anthropic.user_email` with
`anthropic.user_email_digest` in the `tacho/1.0` envelope. `anthropicSchema` is
`.strict()` inside a validator that rejects the whole ingest batch, so one
event from a collector that had not been upgraded would have taken its
batch-mates down with it, and a WAL entry sealed before the change could never
have been sent. Bumping the wire version would not have helped: a sealed entry
is immutable, its hash covers every member, so it can only ever be offered
under the version it was sealed with.

### Third: keying the digest on the control plane

Then: HMAC the pre-image with a key held only by the API deployment, so the
reader cannot reproduce the value. That fixed the entropy problem and left a
larger one. A host key may call `ingest_tacho_events`
(`packages/iam/src/machine-key-scope.ts:69`) and an org **Member** may call
`get_tacho_session` (`packages/oxagen/src/contracts/tacho.session.get.ts:75`,
which filters on org and workspace only). The producer chooses
`anthropic.user_email_digest`, and the server keyed whatever arrived and handed
the result back.

So a tenant could submit the host-hash of a guessed address, read the HMAC out
of their own session, and compare it against a colleague's row — repeating
until it matched. The key never leaks, and it does not need to: **the system
computes the function on demand, for inputs the attacker chooses, and shows
them the answer.** Keeping a key secret protects nothing when the oracle is
free to query.

The general lesson: a stable per-person value that is *derived from
producer-supplied input* and *readable by the principal who supplied it* is a
dictionary attack however it is computed. The strength of the function is not
the variable. The pairing is.

## Decision

**No value derived from the reported address is stored, in either store.** Not
the address, not a hash of it, not a keyed digest of it. `tacho_events` and
`tacho.sessions` carry no such column.

The reason this costs nothing: `tacho.sessions` already carries
`agent_principal_id`, `initiating_principal_id` and `initiating_user_id`
(`packages/database/src/schema/tacho.ts:226-228`) — identities this deployment
mints and governs. "Who is this session's person" was already answered by a
value a producer cannot choose and which needs no key to stay meaningful. The
address digest was a second, weaker answer to a question that already had one.

Nothing consumed it. It reached one contract output field, no surface in
`apps/app`, no entry in `apps/app/capability-ui-map.json`, and nothing in the
repository reads `tacho_events` back at all. The join it theoretically enabled
was never taken.

**The alternatives were considered and rejected.** Salting per-org or
per-session closes the oracle by breaking cross-row comparison — which is the
only thing the value was for, so it pays the full cost and keeps none of the
benefit. Removing the field from `get_tacho_session` alone closes today's read
path while leaving a loaded value in two stores for the next feature that reads
one.

**The collector still hashes, and the wire still accepts both members.** A
current collector sends `anthropic.user_email_digest`, so the address does not
cross the wire; `anthropic.user_email` stays accepted so installed collectors
and sealed WAL entries keep working. The control plane discards both. Hashing
on the host is worth keeping on its own terms — it is the part of the first
round that was right.

## Consequences

An operator cannot see which person a session belongs to by address, and
neither can anyone reading either store. Surfaces that need to name a person
name the principal the enrollment was issued to.

Counting distinct people and following one person across sessions must be built
on the principal columns. That is a better base than a harness observation: it
is an identity Oxagen issues, it survives a person changing their address, and
it cannot be chosen by whoever is submitting events.

There is no key, so there is no key custody, no Parameter Store entry, no
rotation policy, and no window in which a missing secret silently degrades the
record. The three questions the keyed design forced — where the key lives, who
may hold it, what rotation costs — stop existing rather than getting answers.

`get_tacho_session` no longer returns `anthropicUserEmail` or any successor
field. That is a contract output removal visible on the API and MCP surfaces,
and nothing consumed it.

Rows written before this still hold addresses. The columns are dropped in a
later migration, for the reason below.

## Deploy order

This change removes the columns from the code and adds no migration, because
`deploy-node` ships the API on merge with no migration dependency
(`.github/workflows/pipeline.yml:763`, whose own comment records that the
`migrate` wait was retired and that "deploying code ahead of its migration is
what took production login down once already"), while the production Postgres
and ClickHouse migrations are dispatched by hand. That is issue #3186.

A change that alters code and schema together therefore has no safe order:
deploy first and the new handler queries a column that does not exist; migrate
first and the running handler loses a column it still queries. Either way Tacho
ingestion and session reads break until both halves have landed.

Expand/contract removes the dependency instead of trying to sequence two manual
steps. This change is the expand half and it is schema-neutral: the handler
stops writing and reading the column while leaving it in place, so it runs
correctly against the schema production has today and against the one it will
have afterwards. The contract half — dropping `anthropic_user_email` from
`tacho.sessions` and from `tacho_events` — is a migration-only change that can
be dispatched once this rollout has settled and its rollback window has closed,
because by then nothing references the column in either direction.
