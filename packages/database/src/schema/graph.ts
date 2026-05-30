import { index, integer, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { graphSchema } from "./_schemas.js";
import { auditMixin, idMixin, orgScopeMixin } from "./_mixins.js";

export const graphProviders = graphSchema.table(
  "graph_providers",
  {
    ...idMixin("grp"),
    ...auditMixin(),
    ...orgScopeMixin(),
    providerType: text("provider_type").notNull(),
    displayName: text("display_name").notNull(),
    connectionId: uuid("connection_id"),
    status: text("status").notNull(),
  },
  (t) => ({
    orgIdx: index("graph_providers_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const routingRules = graphSchema.table(
  "routing_rules",
  {
    ...idMixin("rrl"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ruleName: text("rule_name").notNull(),
    matchExpression: jsonb("match_expression").notNull(),
    targetGraphId: uuid("target_graph_id").notNull(),
    priority: integer("priority").notNull(),
  },
  (t) => ({
    orgIdx: index("routing_rules_org_idx").on(t.orgId, t.workspaceId),
    // Routing decisions evaluate rules in priority order per tenant.
    tenantPriorityIdx: index("routing_rules_org_priority_idx").on(t.orgId, t.priority),
  }),
);
