// Relays for servers and APIs in a private network (M12, #4685;
// mcp-studio-spec, Network paths).
//
// A relay runs inside your network and connects out to the broker. It
// authenticates with a relay token, and this table keeps only the token's
// SHA-256 in lowercase hex. create_relay shows the plaintext token once.
// revoke_relay sets revoked_at, and the broker refuses the token at the next
// connect and closes a connected relay within 30 seconds.
//
// The verifier (packages/handlers/src/mcp-studio/relays/verifier.ts) looks a
// token up by its hash before any organization is known, so every reader goes
// through withSystemDb on the shared plane. The tenant policy is the backstop.
//
// `workspacePublicId` is copied from workspace.workspaces when the relay is
// created. The verifier returns it so the broker can name the wrk_ id in an
// envelope without a join.
//
// The migration that creates this table and its tenant policies is
// 20260928180000_mcp_relays.sql.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mcpSchema } from "./_schemas";
import { idMixin } from "./_mixins";
import { organizations } from "./org";
import { workspaces } from "./workspace";

export const mcpRelays = mcpSchema.table(
  "relays",
  {
    ...idMixin("rly"),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The workspace's public id, wrk_…, as it was when the relay was created.
    workspacePublicId: text("workspace_public_id").notNull(),
    // The name a network = relay:<name> call routes by.
    name: text("name").notNull(),
    // SHA-256 of the relay token, lowercase hex. Never the token itself.
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdById: uuid("created_by_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedById: uuid("revoked_by_id"),
  },
  (t) => ({
    liveNameIdx: uniqueIndex("relays_workspace_name_live_uq")
      .on(t.orgId, t.workspaceId, t.name)
      .where(sql`${t.revokedAt} IS NULL`),
    workspaceIdx: index("relays_workspace_idx").on(t.orgId, t.workspaceId),
    // RELAY_NAME_PATTERN in @oxagen/mcp-studio.
    nameCheck: check(
      "relays_name_check",
      sql`${t.name} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`,
    ),
    tokenHashCheck: check(
      "relays_token_hash_check",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    revokedByCheck: check(
      "relays_revoked_by_check",
      sql`${t.revokedAt} IS NOT NULL OR ${t.revokedById} IS NULL`,
    ),
  }),
);
