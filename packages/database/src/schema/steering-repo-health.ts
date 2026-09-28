// A steering repo's health (steering-repo-spec, Settings drift; S2, #4560).
//
// One row per steering repo: a workspace's `oxagen-<slug>` or the
// organization's `<org>/oxagen`. The organization repo belongs to no
// workspace, so `workspace_id` is null on its row and the table's tenant
// policy is `workspace_nullable`.
//
// While `health` is not `healthy`, Oxagen merges nothing and publishes
// nothing. `differences` holds the prescribed settings that differ, each with
// who changed it and when, as the failed check and the banner list them.
//
// The migration that creates this table and its tenant policies is
// 20260928013000_steering_repo_health.sql.
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import { uuidv7Default } from "./_mixins";

export const steeringRepoHealth = agentSchema.table(
  "steering_repo_health",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    // Null for the organization repo `<org>/oxagen`.
    workspaceId: uuid("workspace_id"),
    provider: text("provider").notNull(),
    // GitHub's repository id or GitLab's project id.
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    // `owner/name`, or the GitLab project path, as the last read found it.
    repository: text("repository").notNull(),
    health: text("health").notNull(),
    differences: jsonb("differences").notNull().default(sql`'[]'::jsonb`),
    // Why the repo is disconnected or diverged, in one sentence.
    reason: text("reason"),
    // The last published commit, which a diverged repo reverts to.
    publishedSha: text("published_sha"),
    // The version number of `published_sha`, when the host records it.
    publishedVersion: integer("published_version"),
    // The pull request that reverts main to `published_sha`.
    revertPrNumber: integer("revert_pr_number"),
    // The health the workspace admins were last told about, so a state is
    // announced once.
    notifiedHealth: text("notified_health").notNull().default("healthy"),
    // A digest of the health and differences last posted to open pull
    // requests, so an unchanged read posts nothing.
    postedDigest: text("posted_digest"),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // When `health` last changed.
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One row for the organization repo…
    orgRepoIdx: uniqueIndex("steering_repo_health_org_uq")
      .on(t.orgId)
      .where(sql`workspace_id IS NULL`),
    // …and one per workspace repo.
    workspaceRepoIdx: uniqueIndex("steering_repo_health_workspace_uq")
      .on(t.orgId, t.workspaceId)
      .where(sql`workspace_id IS NOT NULL`),
    repositoryIdx: index("steering_repo_health_repository_idx").on(
      t.provider,
      t.repositoryId,
    ),
    providerCheck: check(
      "steering_repo_health_provider_check",
      sql`${t.provider} IN ('github','gitlab')`,
    ),
    healthCheck: check(
      "steering_repo_health_health_check",
      sql`${t.health} IN ('healthy','drifted','disconnected','diverged')`,
    ),
    notifiedCheck: check(
      "steering_repo_health_notified_check",
      sql`${t.notifiedHealth} IN ('healthy','drifted','disconnected','diverged')`,
    ),
  }),
);
