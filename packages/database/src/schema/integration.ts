import { boolean, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { integrationSchema } from "./_schemas";
import { auditMixin, idMixin, softDeleteMixin, orgScopeMixin } from "./_mixins";

export const connections = integrationSchema.table(
  "connections",
  {
    ...idMixin("con"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    credentialId: uuid("credential_id"),
    status: text("status").notNull(),
    syncEnabled: boolean("sync_enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
    config: jsonb("config").notNull(),
  },
  (t) => ({
    orgIdx: index("connections_org_idx").on(t.orgId, t.workspaceId),
    providerIdx: index("connections_provider_idx").on(t.orgId, t.provider),
  }),
);
