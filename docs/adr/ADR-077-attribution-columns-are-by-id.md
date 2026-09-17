# ADR-077: Attribution columns are `<verb>_by_id`

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** the Mission Control spec Appendix A.0 (conventions that apply
  to every table; amended by this ADR), `docs/audits/2026-09-15-schema-audit.md`
  (the audit this decision came out of), migration
  `packages/database/atlas/migrations/20260915230000_attribution_columns_by_id.sql`,
  `packages/database/src/schema/_mixins.ts` (`auditMixin`,
  `appendOnlyAuditMixin`, `softDeleteMixin`),
  `packages/database/src/schema/attribution-columns.test.ts` (the guard),
  `tools/scripts/codemod-attribution-columns.mjs` (the mechanical rename for
  a branch cut before this landed), ADR-001 (Drizzle as the Postgres ORM).

## Context

Every table a person edits carries three audit columns from the shared
mixins: who created the row, who last updated it, who soft-deleted it. Until
this change they were spelled `created_by_user_id`, `updated_by_user_id` and
`deleted_by_user_id`, on eighty-one tables across twenty schemas.

That spelling was the only place in the schema where a reference column
carried its target table in its name. Every other reference is named for the
role the referenced row plays: `org_id`, `user_id`, `approver_id`,
`requester_id`, `principal_id`, `agent_principal_id`. Reading
`created_by_user_id` next to `approver_id` suggests two conventions where
there is one intent, and the `_user_` infix stops meaning anything the moment
an agent or a service principal can create a row, which the IAM model already
allows.

The Mission Control spec's conventions table (Appendix A.0) named the target
columns `created_by`, `updated_by` and `deleted_by`, with no suffix at all.
Two things argue against dropping the suffix. First, the contracts already
use `createdBy` for something else: `iam.role.list` returns the creator's
display name under that key, resolved from the id, so a row column of the
same name would put the id and the name one letter apart in the code that
joins them. Second, a column that ends in `_id` reads as a reference without
a schema lookup; `created_by` alone could hold a name, an email or an id, and
in `control.approvals.resolved_by` the spec itself uses the bare form for a
text column that may hold `policy:<rule id>`, which is exactly the ambiguity
the suffix removes.

The rename touched 193 files. The Drizzle schema, the handlers, the
contracts, the app, the API, the MCP and CLI surfaces, the docs and the
capability JSON schemas all changed together, because a property rename in
a Drizzle table is a compile error everywhere the old name was read.

## Decision

1. An attribution column is named `<verb>_by_id`: `created_by_id`,
   `updated_by_id`, `deleted_by_id` from the mixins, and the same shape for
   any per-table column that holds a user or principal reference
   (`invited_by_id`, `granted_by_id`, `issued_by_id`, `approved_by_id`,
   `revoked_by_id`). The TypeScript property is the camel-case form:
   `createdById`, `updatedById`, `deletedById`.
2. A column that holds an attribution *value* that is not a reference keeps
   the bare form and a text type. `control.approvals.resolved_by` is the one
   such column in the target schema.
3. `createdBy`, `updatedBy` and friends without a suffix are reserved for a
   resolved projection in a contract output (a display name, a principal
   summary), never for a column.
4. The three shared columns were renamed in place by one migration that
   reads `information_schema` and renames every match in every schema, so it
   covers a table created by a migration that merged before it without
   naming that table. It is idempotent.
5. `packages/database/src/schema/attribution-columns.test.ts` fails the unit
   suite when any exported table spells the trio the old way.
6. The two per-table columns that still lack the suffix,
   `iam.principal_role_assignments.assigned_by` and
   `ingestion.deletion_jobs.requested_by`, are renamed by the Mission
   Control lanes that own those tables (Appendix A.4 already calls the
   first `granted_by`; it becomes `granted_by_id`).

## Consequences

- A lane branch cut before this change breaks at typecheck after it rebases
  onto `app-rebuild`. `node tools/scripts/codemod-attribution-columns.mjs`
  applies the rename to every tracked file except the migration history;
  a not-yet-merged migration that still spells `created_by_user_id` in a
  `CREATE TABLE` must be edited by hand, and `pnpm db:atlas-validate`
  reports the drift if it is not.
- Nothing outside Postgres changed. Neo4j already used `created_by_id`
  on `:AgentMemory`; ClickHouse attributes by `principal_id` / `user_id`.
- The API output of `list_plugins` and the JSON schema under
  `docs/capabilities/schemas/list_plugins.json` changed field names
  (`createdById`, `updatedById`, `deletedById`). There are no external
  consumers yet; this is the window in which such a rename is free.
