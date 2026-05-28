import { boolean, index, integer, jsonb, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workflowSchema } from "./_schemas.js";
import {
  auditMixin,
  citext,
  idMixin,
  jsonContractMixin,
  softDeleteMixin,
  tenantScopeMixin,
  versionMixin,
} from "./_mixins.js";

export const playbooks = workflowSchema.table(
  "playbooks",
  {
    ...idMixin("pbk"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("playbooks_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantIdx: index("playbooks_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);

export const playbookVersions = workflowSchema.table(
  "playbook_versions",
  {
    ...idMixin("pbv"),
    ...auditMixin(),
    ...tenantScopeMixin(),
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
    ...tenantScopeMixin(),
    ...jsonContractMixin(),
    playbookVersionId: uuid("playbook_version_id").notNull(),
    stepKey: text("step_key").notNull(),
    stepType: text("step_type").notNull(),
    promptTemplateId: uuid("prompt_template_id"),
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
    ...idMixin("pls"),
    playbookStepId: uuid("playbook_step_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    modelOverride: text("model_override"),
    maxRetries: integer("max_retries").notNull().default(0),
    timeoutSeconds: integer("timeout_seconds"),
  },
  (t) => ({
    stepIdx: index("playbook_step_assignments_step_idx").on(t.playbookStepId),
    agentVersionIdx: index("playbook_step_assignments_agent_version_idx").on(t.agentVersionId),
  }),
);

export const promptTemplates = workflowSchema.table(
  "prompt_templates",
  {
    ...idMixin("tpl"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("prompt_templates_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantIdx: index("prompt_templates_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);

export const promptTemplateVersions = workflowSchema.table(
  "prompt_template_versions",
  {
    ...idMixin("ptv"),
    ...auditMixin(),
    ...versionMixin(),
    promptTemplateId: uuid("prompt_template_id").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    userPrompt: text("user_prompt").notNull(),
    templateVariables: jsonb("template_variables").notNull(),
  },
  (t) => ({
    templateIdx: index("prompt_template_versions_template_idx").on(t.promptTemplateId),
    templateLatestIdx: uniqueIndex("prompt_template_versions_template_latest_idx")
      .on(t.promptTemplateId)
      .where(sql`is_latest = true`),
    templateVersionIdx: uniqueIndex("prompt_template_versions_template_version_idx").on(
      t.promptTemplateId,
      t.versionNumber,
    ),
  }),
);
