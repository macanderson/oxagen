import { boolean, index, integer, jsonb, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workflowSchema } from "./_schemas";
import {
  auditMixin,
  citext,
  idMixin,
  jsonContractMixin,
  softDeleteMixin,
  orgScopeMixin,
  versionMixin,
} from "./_mixins";

export const playbooks = workflowSchema.table(
  "playbooks",
  {
    ...idMixin("pbk"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
  },
  (t) => ({
    orgSlugIdx: uniqueIndex("playbooks_org_slug_idx").on(t.orgId, t.slug),
    orgIdx: index("playbooks_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const playbookVersions = workflowSchema.table(
  "playbook_versions",
  {
    ...idMixin("pbv"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...versionMixin(),
    playbookId: uuid("playbook_id").notNull(),
    entryStepId: uuid("entry_step_id"),
    graphDefinition: jsonb("graph_definition").notNull(),
    isActive: boolean("is_active").notNull().default(false),
  },
  (t) => ({
    playbookIdx: index("playbook_versions_playbook_idx").on(t.playbookId),
    playbookLatestIdx: uniqueIndex("playbook_versions_playbook_latest_idx")
      .on(t.playbookId)
      .where(sql`is_latest = true`),
    playbookVersionIdx: uniqueIndex("playbook_versions_playbook_version_idx").on(
      t.playbookId,
      t.versionNumber,
    ),
  }),
);

export const playbookSteps = workflowSchema.table(
  "playbook_steps",
  {
    ...idMixin("stp"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...jsonContractMixin(),
    playbookVersionId: uuid("playbook_version_id").notNull(),
    stepKey: text("step_key").notNull(),
    stepType: text("step_type").notNull(),
    executionOrder: integer("execution_order"),
    retryPolicy: jsonb("retry_policy").notNull().default(sql`'{}'::jsonb`),
    timeoutPolicy: jsonb("timeout_policy").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    versionIdx: index("playbook_steps_version_idx").on(t.playbookVersionId),
    versionKeyIdx: uniqueIndex("playbook_steps_version_key_idx").on(t.playbookVersionId, t.stepKey),
  }),
);

export const playbookStepAssignments = workflowSchema.table(
  "playbook_step_assignments",
  {
    ...idMixin("psa"),
    ...orgScopeMixin(),
    playbookStepId: uuid("playbook_step_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    modelOverride: text("model_override"),
    maxRetries: integer("max_retries").notNull().default(0),
    timeoutSeconds: integer("timeout_seconds"),
  },
  (t) => ({
    stepIdx: index("playbook_step_assignments_step_idx").on(t.playbookStepId),
    agentVersionIdx: index("playbook_step_assignments_agent_version_idx").on(t.agentVersionId),
    orgIdx: index("playbook_step_assignments_org_idx").on(t.orgId, t.workspaceId),
  }),
);

