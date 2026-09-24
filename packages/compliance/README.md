# @oxagen/compliance

`@oxagen/compliance` is the single source of the SOC 2 security-event taxonomy: every `security_events.event_type` and outcome value, which of them something actually writes, and the SQL `CHECK` clauses generated from that list. It is a leaf package with no store.

## Boundary

- **Owns:** `SECURITY_EVENT_TYPES`, `SECURITY_OUTCOMES`, the reserved and emitted subsets (`RESERVED_SECURITY_EVENT_TYPES`, `EMITTED_SECURITY_EVENT_TYPES`), the typed event detail shapes, and the `CHECK` clause builders in `src/db-check.ts`. It also owns the audit-coverage test that `pnpm check:audit-coverage` runs.
- **Does not own:** the `security_events` table and its Drizzle schema ([`@oxagen/database`](../database/README.md), `src/schema/security.ts`), writing events ([`@oxagen/database`](../database/README.md) `./security` and [`@oxagen/telemetry`](../telemetry/README.md)), or the kernel's `capability.invoke_*` audit ([`@oxagen/oxagen`](../oxagen/README.md)).
- **Depends on:** no `@oxagen/*` runtime dependencies.
- **Used by:** `@oxagen/database`, `@oxagen/telemetry`, `apps/app` (the audit filters in `src/features/audit/filters.ts`), and `apps/app_deprecated`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `SECURITY_EVENT_TYPES` and `SecurityEventType` | export | `packages/compliance/src/security-event-types.ts` | `packages/database/src/schema/security.ts` and `packages/telemetry/src/security.ts` |
| `generateEventTypeCheckClause`, `generateOutcomeCheckClause` | boundary | `packages/compliance/src/db-check.ts` | The Drizzle `check()` in `packages/database/src/schema/security.ts`; migration authors paste the same output into `packages/database/atlas/migrations/` |
| `EMITTED_SECURITY_EVENT_TYPES` | export | `packages/compliance/src/security-event-types.ts` | The audit filter list in `apps/app/src/features/audit/filters.ts` |
| Audit-coverage allowlist | boundary | `packages/compliance/src/audit-coverage.test.ts` | `pnpm check:audit-coverage` (root `package.json`), run on every PR in CI |

## Entry points

- `.` (`src/index.ts`): the taxonomy, its type guards, the detail types, and the `CHECK` clause builders.

## Rules

- Never remove an event type that has shipped. Audit rows that carry it must stay readable, so deprecate it in a comment instead.
- A new event type is one edit, in `src/security-event-types.ts`. The migration that widens the database `CHECK` pastes the generated clause rather than retyping the list.
- A declared type is not an emitted one. `security-event-types.test.ts` greps the repo for each literal and fails when a reserved type gains an emitter or an emitted type loses its last one (#2528).
- Name types `<domain>.<event>`. Outcomes live in `SECURITY_OUTCOMES`, not in the type name.

## Tests

```bash
pnpm --filter @oxagen/compliance test:unit src/security-event-types.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`. `pnpm check:audit-coverage` runs `src/audit-coverage.test.ts` alone.
