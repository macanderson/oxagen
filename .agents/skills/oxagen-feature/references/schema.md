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
pnpm drizzle-kit generate   # creates the migration from the schema diff
pnpm drizzle-kit migrate    # applies it to the dev database
```

## Rules

- Multitenancy is mandatory. Every domain table has `tenant_id`; workspace-scoped tables also carry `workspace_id`. Index `tenant_id`.
- Generate migrations, do not write them by hand. Commit the generated file.
- If the capability writes to Neo4j as well as Postgres, keep the relational row as the system of record and treat the graph as a projection. Document the sync point in SPEC.md.
