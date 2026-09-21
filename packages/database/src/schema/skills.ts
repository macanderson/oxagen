import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { skillsSchema } from "./_schemas";
import { appendOnlyAuditMixin, idMixin, orgScopeMixin } from "./_mixins";
import type { SkillConfig } from "@oxagen/oxagen/skills";

/** Immutable read-back of the repository file at a published commit (ADR-090). */
export const skillConfigVersions = skillsSchema.table(
  "config_versions",
  {
    ...idMixin("skv"),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    versionLabel: text("version_label").notNull(),
    repositoryBindingId: uuid("repository_binding_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    pullRequestNumber: integer("pull_request_number"),
    enabled: boolean("enabled").notNull().default(false),
    configDigest: text("config_digest").notNull(),
    sources: jsonb("sources").$type<SkillConfig["sources"]>().notNull(),
    search: jsonb("search").$type<SkillConfig["search"]>().notNull(),
    unboundRepo: jsonb("unbound_repo")
      .$type<SkillConfig["unbound_repo"]>()
      .notNull(),
    reflection: jsonb("reflection")
      .$type<SkillConfig["reflection"]>()
      .notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    versionUnique: uniqueIndex("skill_config_versions_label_uq").on(
      t.orgId,
      t.workspaceId,
      t.versionLabel,
    ),
    commitUnique: uniqueIndex("skill_config_versions_commit_uq").on(
      t.orgId,
      t.workspaceId,
      t.repositoryBindingId,
      t.commitSha,
    ),
    scopedId: uniqueIndex("skill_config_versions_scoped_id_uq").on(
      t.orgId,
      t.workspaceId,
      t.id,
    ),
    published: index("skill_config_versions_published_idx").on(
      t.orgId,
      t.workspaceId,
      t.publishedAt,
    ),
    digest: check(
      "skill_config_versions_digest_check",
      sql`${t.configDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    commit: check(
      "skill_config_versions_commit_check",
      sql`${t.commitSha} ~ '^[a-f0-9]{40,64}$'`,
    ),
    pr: check(
      "skill_config_versions_pr_check",
      sql`${t.pullRequestNumber} IS NULL OR ${t.pullRequestNumber} > 0`,
    ),
  }),
);

/** Decisions retain their pinned configuration even after another version is published. */
export const skillResolutions = skillsSchema.table(
  "resolutions",
  {
    ...idMixin("skr"),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    configVersionId: uuid("config_version_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    skillId: text("skill_id").notNull(),
    skillVersion: text("skill_version").notNull(),
    skillDigest: text("skill_digest").notNull(),
    source: text("source").notNull(),
    decision: text("decision")
      .$type<"allowed" | "needs_approval" | "denied">()
      .notNull(),
    withheldReason: text("withheld_reason").$type<
      "out_of_scope" | "unapproved_digest"
    >(),
    loaded: boolean("loaded").notNull().default(false),
    tokenCost: integer("token_cost").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    config: foreignKey({
      name: "skill_resolutions_config_fk",
      columns: [t.orgId, t.workspaceId, t.configVersionId],
      foreignColumns: [
        skillConfigVersions.orgId,
        skillConfigVersions.workspaceId,
        skillConfigVersions.id,
      ],
    }),
    run: index("skill_resolutions_run_idx").on(
      t.orgId,
      t.workspaceId,
      t.runId,
      t.resolvedAt,
    ),
    decision: check(
      "skill_resolutions_decision_check",
      sql`${t.decision} IN ('allowed', 'needs_approval', 'denied')`,
    ),
    held: check(
      "skill_resolutions_withheld_check",
      sql`${t.withheldReason} IS NULL OR (${t.withheldReason} IN ('out_of_scope', 'unapproved_digest') AND ${t.decision} = 'denied' AND NOT ${t.loaded} AND ${t.tokenCost} = 0)`,
    ),
    load: check(
      "skill_resolutions_load_check",
      sql`NOT ${t.loaded} OR ${t.decision} = 'allowed'`,
    ),
    cost: check("skill_resolutions_cost_check", sql`${t.tokenCost} >= 0`),
    digest: check(
      "skill_resolutions_digest_check",
      sql`${t.skillDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  }),
);
