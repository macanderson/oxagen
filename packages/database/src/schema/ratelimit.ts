// ratelimit.ts — distributed API rate-limit counters.
//
// One lean table backs the Postgres-store fixed-window limiter mounted on the
// chat + agent-execution surfaces (apps/api/src/middleware/distributed-rate-
// limit.ts). Postgres is the store because it is the only shared, transactional
// store in the stack — vendor-neutrality is a core moat, so we deliberately do
// NOT reach for Redis/Upstash. Better Auth already keeps its own `rate_limit`
// counters in Postgres (schema/auth.ts), so this follows an established
// in-repo precedent rather than inventing infrastructure.
//
// DELIBERATE DEVIATION FROM SQL CONVENTIONS (§ SQL conventions: uuid id +
// public_id + audit mixin): this is a hot, ephemeral counter, not a domain
// entity. The natural composite key (bucket_key, window_start) IS the upsert
// conflict target — one atomic `INSERT ... ON CONFLICT DO UPDATE count = count
// + 1 RETURNING count` per request. A surrogate uuid id would add a second
// unique index to maintain on every hit for zero benefit (nothing ever
// references a counter row by id), and public_id / created_by / updated_at
// would be dead weight on a row whose entire lifecycle is "increment a few
// times, then get swept". This mirrors Better Auth's equally lean `rate_limit`
// table. Rows are transient: the limiter opportunistically deletes windows
// older than two windows, so the table stays small.
//
// NOT tenant-scoped: a counter keys on workspace OR org OR client IP, so there
// is no single (org_id, workspace_id) it belongs to. Access is exclusively
// through the audited withSystemDb bypass, and the migration gives the table a
// bypass-only RLS policy — a tenant query can never read another org's counters.

import { integer, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { ratelimitSchema } from "./_schemas";

/**
 * Fixed-window request counters. `bucket_key` is `<route-group>:<scope>` where
 * scope is `ws:<workspaceId>`, `org:<orgId>`, or a client IP; `window_start` is
 * the epoch-aligned start of the current fixed window. `count` is the number of
 * requests seen for that bucket in that window.
 */
export const rateLimitCounters = ratelimitSchema.table(
  "rate_limit_counters",
  {
    bucketKey: text("bucket_key").notNull(),
    windowStart: timestamp("window_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bucketKey, t.windowStart] }),
  }),
);
