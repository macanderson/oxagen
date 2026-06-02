import { boolean, index, jsonb, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

export const workflowTriggers = eventSchema.table(
  "workflow_triggers",
  {
    ...idMixin("wtr"),
    ...orgScopeMixin(),
    triggerId: uuid("trigger_id").notNull(),
    playbookVersionId: uuid("playbook_version_id").notNull(),
  },
  (t) => ({
    triggerIdx: index("workflow_triggers_trigger_idx").on(t.triggerId),
    playbookVersionIdx: index("workflow_triggers_playbook_version_idx").on(t.playbookVersionId),
    pairIdx: uniqueIndex("workflow_triggers_pair_idx").on(t.triggerId, t.playbookVersionId),
    orgIdx: index("workflow_triggers_org_idx").on(t.orgId, t.workspaceId),
  }),
);
