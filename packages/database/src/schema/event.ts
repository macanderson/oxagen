import { boolean, index, jsonb, text } from "drizzle-orm/pg-core";
import { eventSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin } from "./_mixins";

export const triggers = eventSchema.table(
  "triggers",
  {
    ...idMixin("tri"),
    ...auditMixin(),
    ...orgScopeMixin(),
    name: text("name").notNull(),
    eventType: text("event_type").notNull(),
    filterExpression: jsonb("filter_expression").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (t) => ({
    orgIdx: index("triggers_org_idx").on(t.orgId, t.workspaceId),
    eventTypeIdx: index("triggers_event_type_idx").on(t.orgId, t.eventType),
  }),
);

