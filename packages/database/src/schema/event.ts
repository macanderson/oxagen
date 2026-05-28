import { boolean, index, jsonb, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { eventSchema } from "./_schemas.js";
import { auditMixin, idMixin, tenantScopeMixin } from "./_mixins.js";

export const triggers = eventSchema.table(
  "triggers",
  {
    ...idMixin("tri"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    name: text("name").notNull(),
    eventType: text("event_type").notNull(),
    filterExpression: jsonb("filter_expression").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (t) => ({
    tenantIdx: index("triggers_tenant_idx").on(t.tenantId, t.workspaceId),
    eventTypeIdx: index("triggers_event_type_idx").on(t.tenantId, t.eventType),
  }),
);

export const workflowTriggers = eventSchema.table(
  "workflow_triggers",
  {
    ...idMixin("wtr"),
    triggerId: uuid("trigger_id").notNull(),
    playbookVersionId: uuid("playbook_version_id").notNull(),
  },
  (t) => ({
    triggerIdx: index("workflow_triggers_trigger_idx").on(t.triggerId),
    playbookVersionIdx: index("workflow_triggers_playbook_version_idx").on(t.playbookVersionId),
    pairIdx: uniqueIndex("workflow_triggers_pair_idx").on(t.triggerId, t.playbookVersionId),
  }),
);
