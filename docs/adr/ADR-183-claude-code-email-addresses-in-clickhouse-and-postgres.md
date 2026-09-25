# ADR-183: Claude Code email addresses in ClickHouse and Postgres

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** issue #3072 (with #3176 and #3210 folded in), ADR-084 (the
  session's person is a principal Oxagen issues), #3173 (the writers
  stopped), #3624 (the backfill stopped sending the address), OXA-1721 (the
  erasure cascade), ClickHouse migrations 0007, 0027 and 0031, Atlas
  migration 20260925230100.

## Context

Three columns held a Claude Code user's email address in plain text.

| Column | Created by | Writers | Access control |
|---|---|---|---|
| ClickHouse `tacho_events.anthropic_user_email` | 0027 | none since #3173 | none: ClickHouse has no row policy |
| Postgres `tacho.sessions.anthropic_user_email` | 20260908120000 | none since #3173 | row-level security |
| ClickHouse `claude_sessions.user_email` | 0007 | none since #3624 | none |

ADR-084 stopped every reader and writer of the two tacho columns and held
their drop until the rollback window of #3173 closed, so a rolled-back release
would not meet a missing column. The rows written before #3173 still held
addresses. Nothing in the tree reads either column today: the Drizzle schema
does not declare the Postgres one, and the ClickHouse one sits in
`RETIRED_COLUMNS` only so the generated 0027 keeps matching what clusters
applied.

`claude_sessions` is the table the Claude Code session backfill
(`tools/scripts/backfill-claude-telemetry.ts`) writes. `user_email` is the
first column of its sort key, and the table keeps rows for two years (`TTL
toDateTime(timestamp) + INTERVAL 2 YEAR`). A sort-key column cannot be
rewritten in place, so a digest would mean rebuilding the table. The privacy
processor (`privacy.erasure.execute.ts`) named this table as an open question
under OXA-1721: erase the rows, or keep them under a stated policy. Its
comment also named a `claude_telemetry` table, which never existed: 0006
created `agent_executions` and 0007 dropped it.

On 2026-09-25 Mac decided both questions. The product has no customers, so
the #3173 rollback window no longer matters.

## Decision

### 1. The two tacho columns

Both are dropped now. ClickHouse migration `0031_drop_tacho_events_anthropic_user_email.sql` drops
the column from `tacho_events`, and Atlas migration
`20260925230100_drop_tacho_sessions_anthropic_user_email.sql` drops it from
`tacho.sessions`. `migration-gate` applies both when the change merges. The
drop removes the stored addresses, which is the point.

0027 stays byte-identical. The generator in `tacho-events-ddl.ts` lists the
column in `DROPPED_COLUMNS`, which puts it back into the generated 0027 and
leaves it out of the live column set every writer projects onto. A cluster
bootstrapped today creates the column in 0027 and drops it in 0031, so it ends
where an older cluster ends.

### 2. The `claude_sessions` address

The column stays, under the table's existing two-year TTL, and a privacy
erasure deletes a person's rows on request. A digest is not an
improvement: ADR-084 records why any stable value computed from an address is
a dictionary oracle, and the digest would cost a table rebuild.

The privacy processor gains an erasure path. For a user-scope request, the
`erase-clickhouse-rows` step reads the subject's address from `auth.users`
and calls `eraseClaudeSessionRows` (`packages/telemetry/src/claude-telemetry.ts`),
which runs:

```sql
ALTER TABLE claude_sessions DELETE WHERE user_email = {email:String}
```

with `mutations_sync = 2`, so the step returns only after the rows are gone.
The step runs before `execute-erasure`, because that step overwrites the
address in `auth.users`. The address never leaves the step: Inngest stores a
step's return value, so the step returns only whether it erased anything.

A ClickHouse failure does not block the auth purge. Inngest retries the step,
and once it gives up, `execute-erasure` still deletes the person's credentials
and preferences and scrubs the name and avatar. It keeps the address, the only
key the rows can be matched by, so a re-run of the request can erase them. The
failure message the processor records names what happened: rows deleted, no
address left to match, or the erase failed and the address was kept.

A mutation, not a lightweight `DELETE FROM`. A lightweight delete hides the
rows and leaves the bytes on disk until a later merge. A mutation rewrites
every part that holds a matching row.

## Consequences

- The drops are irreversible. Once `migration-gate` applies them, the
  addresses written before #3173 are gone from both stores.
- `RETIRED_COLUMNS` is empty. Retiring a column still means listing it there
  first, then moving it to `DROPPED_COLUMNS` with the migration that drops it.
- The erasure matches the address on the person's Oxagen account. Rows from a
  Claude Code login under a different address are not matched, and they expire
  under the TTL. The failure message lists them as residual.
- A request whose ClickHouse erase failed keeps the account address in
  `auth.users` until a re-run erases the rows.
- The erasure reaches `claude_sessions` in the database the application's
  ClickHouse client names (`CLICKHOUSE_DATABASE`), where the migrations create
  it. The backfill writes `internal.claude_sessions` at the operator endpoint
  `PRODUCTION_ANALYTICS_URL`, which holds the team's own developer sessions.
  The application holds no credentials for that endpoint, and this decision
  does not reach it.
- An empty address is refused. Rows written after #3624 carry the empty
  string, and deleting by it would delete every one of them.
- The processor still refuses to mark a request `completed`. Three blockers
  remain under OXA-1721: the Neo4j erase-by-owner path, the blob cascade, and
  org-scope Postgres semantics.

## Alternatives considered

- **Digest `claude_sessions.user_email` with a table rebuild.** Rejected for
  the ADR-084 oracle argument, and because an `INSERT ... SELECT` over the
  table is the kind of read that reaches the app node's memory cap.
- **Drop `claude_sessions.user_email`.** A sort-key column cannot be dropped
  without the same rebuild.
- **Keep the tacho columns until a later release.** The rollback window was
  the only reason, and it does not apply while there are no customers.
