# ADR-050: Privileged secret access is recorded in the main audit log, not only beside it

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #2527 (secret access invisible to the main audit log),
  issue #2533 (plugin credentials logged nowhere), issue #2530 (what the
  coverage check does and does not prove),
  `packages/compliance/src/security-event-types.ts`,
  `packages/database/atlas/migrations/20260908010000_secret_and_plugin_credential_security_events.sql`

## Context

Revealing or exporting a workspace secret wrote a row to
`environments.secret_access_log`, a table inside `@oxagen/plugins`. Setting,
unsetting, upserting or deleting one wrote nothing anywhere. Storing or deleting
a plugin's OAuth token or secret wrote nothing either, and both of those
handlers carried an `audit-exempt` comment saying no fitting event type existed
— which was a correct reading of the taxonomy.

So the most privileged actions in the product were invisible to the main audit
log query, the audit-log UI, and `SECURITY_EVENT_TYPES`. Somebody asking "who
read our secrets" through the normal audit tools got an empty answer, and
nothing told them they were asking the wrong table.

Two options were on the table (#2527): add a `secret.*` family to the main
taxonomy, or keep `secret_access_log` as its own surface and expose it in the
audit-log UI.

## Decision

**Both records exist. The main audit log is where the question is asked.**

Every privileged secret and plugin-credential action now emits a
`security_events` row. `secret_access_log` stays exactly as it is.

They are not duplicates of each other. `secret_access_log` is a per-secret
record — which key, which environment, resolved from where — and it is the right
place to answer "what happened to *this* secret". `security_events` is the
cross-domain trail an auditor reads end to end, and a control that only appears
in a domain-specific table is a control nobody finds. Keeping one and dropping
the other would lose either the detail or the discoverability.

The surfacing option was rejected on the same ground. Putting
`secret_access_log` in the audit-log UI would answer the UI half and leave the
query half: `SECURITY_EVENT_TYPES` would still not name secret access, and a
`SELECT` against `security_events` would still return nothing.

### The families

`plugin.credential_set` / `plugin.credential_revoked`, and `secret.revealed` /
`secret.exported` / `secret.value_changed` / `secret.key_deleted`.

**Reveal and export are reads, and they are in this list anyway.** Reading a
secret in the clear is the privileged act the trail exists to catch; the write
is often the less interesting half.

**One type covers set, unset and upsert.** Each is a change to secret material,
and the row's `capability` field — `set_secret_value`, `unset_secret_value`,
`upsert_secret_key` — is what tells them apart in a query. A type per verb would
grow the taxonomy without answering a question the capability field does not.

### The rule is enforced, not remembered

`secret.` joins `REQUIRED_EMIT_PREFIXES` in `audit-coverage.test.ts`, so a new
secret handler must emit or carry an explicit `// audit-exempt:` reason. Two of
today's do carry one: listing key names discloses no value, and a dry-run env
import changes nothing.

That check is shallow by construction and says so above its own regex (#2530):
it proves a call exists, not that it is reachable or on the success path. The
per-handler tests are what assert the row. `secret-and-credential-audit.test.ts`
covers the reachability the regex cannot — a dry-run import emits nothing, and a
credential write that throws emits nothing, so a row means the thing happened.

## Consequences

- The `security_events` CHECK constraint grows by six values. The migration is
  additive and replayable; no row is rewritten.
- Two audit surfaces record overlapping facts about the same reveal. That is the
  cost of this decision, and it is deliberate: the detail lives in one, the
  discoverability in the other.
- A high-traffic export path now writes one audit row per call. These are
  Owner/Admin operations measured in tens per day, not per second.
