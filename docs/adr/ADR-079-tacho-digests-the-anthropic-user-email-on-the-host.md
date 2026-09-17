# ADR-079: Tacho digests the Anthropic user email on the host, and stores only the digest

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** platform
- **Related:** `docs/specs/tacho/data-model.md` §2.2 (the Anthropic-side
  observations), issue #3072 (the defect this settles), ADR-042 (data planes —
  the stores resolve per organisation), ADR-043 (runtime excision — evidence
  arrives through the ledger and the tacho seam)

## Context

`tacho_events` carried `anthropic_user_email`: the real, readable address of
the person behind the session, written through from the harness. Every other
column on that table that identifies a person is a digest —
`anthropic_user_id_hash`, `prompt_digest`, `tool_input_digest`,
`hostname_digest`, `os_user_digest` — and the table's own header says bodies
are digested. ClickHouse has no row policy, so the address was the one
plaintext personal identifier an ordinary org-scoped analytics query could read
back out. The same value was also on `tacho.sessions.anthropic_user_email` in
Postgres, where RLS applies but the value is still readable.

Nothing read it. The address reached exactly one reader — the
`anthropicUserEmail` field on `get_tacho_session`'s output — and no surface in
`apps/app` renders it. There is no product behaviour that needs to display a
person's address; what the fleet record needs is to tell one person from
another and to follow one person across sessions.

Issue #3072 framed the choice as digest the column in place, or drop the value
when ClickHouse tables retire into frames and archive segments at the Mission
Control cutover. Dropping it at cutover leaves the exposure standing until the
cutover lands, and the cutover is not scheduled; it also answers nothing about
the Postgres copy, which the cutover does not touch.

## Decision

The collector digests the address on the host and the address never leaves the
machine it was observed on.

`digestUserEmail` (`packages/tacho/src/digest.ts`) is the one implementation.
`packages/tacho/src/claude-code/otel.ts` applies it where OTel `user.email` is
read, so the `tacho/1.0` envelope carries `anthropic.user_email_digest` and has
no member that can hold an address. `user.email` stays in `LOG_PROMOTED` there,
because promoted keys are the ones held out of the leftover `attrs` map:
removing it would put the address straight back into a stored column under a
different name.

Both stores carry `anthropic_user_email_digest` and no plaintext column.
Rows already written were backfilled in place and the plaintext column dropped
— `packages/telemetry/src/migrations/0028_tacho_events_email_digest.sql` for
ClickHouse, `20260917063500_tacho_sessions_email_digest.sql` for Postgres —
each reproducing `digestUserEmail` in SQL so a backfilled row joins a newly
written one.

The digest is domain-separated: SHA-256 over a fixed domain string
(`oxagen:tacho:user_email:v1`), a NUL byte, and the address lowercased and
trimmed. An email address carries so little entropy that a bare
`sha256(address)` is reversible by anyone holding a list of candidate
addresses, which would make a stored bare hash the address again in a thin
disguise. `authorizationFingerprintBucketKey`
(`apps/api/src/middleware/distributed-rate-limit.ts`) is the same construction
for the same reason, and this follows it rather than introducing a second
convention.

## Consequences

The fleet record can still count distinct people and follow one person across
sessions: the digest is stable per address, and case and surrounding space are
normalised first, so the same person digests the same way whatever the harness
reports. It cannot show an operator who a session belongs to by address. When
a surface needs to name a person, it names the Oxagen principal the enrollment
was issued to, which is an identity Oxagen owns and governs, rather than an
observation the harness happened to emit.

A digest cannot be undone, so the addresses in rows written before this are
gone rather than hidden. That is the intended outcome for a value nothing read.

`get_tacho_session` returns `anthropicUserEmailDigest` where it returned
`anthropicUserEmail`. The field is a contract output rename, visible on the API
and MCP surfaces.

Anything else that digests a low-entropy identifier belongs in
`packages/tacho/src/digest.ts` beside this one, with its own domain string, so
the reasoning stays in one place.
