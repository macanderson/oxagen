import { index, integer, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { graphSchema } from "./_schemas.js";
import { auditMixin, idMixin, tenantScopeMixin } from "./_mixins.js";

export const graphProviders = graphSchema.table(
  "graph_providers",
  {
    ...idMixin("grp"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    providerType: text("provider_type").notNull(),
    displayName: text("display_name").notNull(),
    connectionId: uuid("connection_id"),
    status: text("status").notNull(),
  },
  (t) => ({
    tenantIdx: index("graph_providers_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);

export const routingRules = graphSchema.table(
  "routing_rules",
  {
    ...idMixin("rrl"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    ruleName: text("rule_name").notNull(),
    matchExpression: jsonb("match_expression").notNull(),
    targetGraphId: uuid("target_graph_id").notNull(),
    priority: integer("priority").notNull(),
  },
  (t) => ({
    tenantIdx: index("routing_rules_tenant_idx").on(t.tenantId, t.workspaceId),
    // Routing decisions evaluate rules in priority order per tenant.
    tenantPriorityIdx: index("routing_rules_tenant_priority_idx").on(t.tenantId, t.priority),
  }),
);
