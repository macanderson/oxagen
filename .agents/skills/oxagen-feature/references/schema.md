# Drizzle schema + migration

Reflect the capability's persistence needs in the Drizzle schema, then generate a migration. Never hand-edit generated SQL except to add data backfills.

## Schema

```ts
// packages/oxagen/src/db/schema/<entity>.ts
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const <entity> = pgTable("<entity>", {
  id: uuid("id").primaryKey().defaultRandom(),
  // EVERY tenant-scoped row carries tenant_id and (where relevant) workspace_id
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  // ...capability fields
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("<entity>_tenant_idx").on(t.tenantId),
}));
```

## Migration

```bash
pnpm db:generate   # drizzle-kit drafts the migration SQL from the schema diff
# → hand-edit the generated SQL: tighten constraints/indexes, make it idempotent
#   (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), pick the next free ordinal.
pnpm db:lint-migrations   # validates naming + ordinal uniqueness (also runs in CI)
pnpm db:migrate    # canonical multi-store runner (Postgres → ClickHouse → Neo4j)
```

> Do NOT run `drizzle-kit migrate` — it is disabled. It applies via the local
> drizzle journal, which is NOT the source of truth. `pnpm db:migrate`
> (tools/scripts/db-migrate.ts) globs the SQL files, tracks them with checksums
> in `public._migrations`, and refuses to re-run an edited shipped migration.

## Rules

- Multitenancy is mandatory. Every domain table has `tenant_id`; workspace-scoped tables also carry `workspace_id`. Index `tenant_id`.
- Use `drizzle-kit generate` to draft the SQL, then hand-edit it (per the spec, reviewers tighten constraints/indexes and make it idempotent) before committing. Shipped migrations are immutable — never edit an applied file; add a new one (engineering policy §5).
- If the capability writes to Neo4j as well as Postgres, keep the relational row as the system of record and treat the graph as a projection. Document the sync point in SPEC.md.
