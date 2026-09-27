// Published steering versions (steering-repo-spec, Steering PR flow: Publish;
// S3, #4449).
//
// publish() in @oxagen/steering-bundle turns a merge into the next version of
// a steering repository. Each version it builds is kept in
// `steering_versions`, published or not, so a number is never reused.
// `steering_publications` holds one row per repository: the published version,
// and the lease that lets one publish of the repository run at a time.
//
// `repository` is the repository's reference, `github.com/<owner>/<name>` or
// `gitlab.com/<group>/<name>`, as the bundle names it.
//
// The migration that creates these tables and their tenant policies is
// 20260927160000_steering_versions.sql.
import {
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
import { orgScopeMixin, uuidv7Default } from "./_mixins";

export const steeringVersions = agentSchema.table(
  "steering_versions",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    repository: text("repository").notNull(),
    version: integer("version").notNull(),
    // The merge commit the version was built from.
    commitSha: text("commit_sha").notNull(),
    // The version's bundle/v1.
    bundle: jsonb("bundle").notNull(),
    // Set the first time the version is made the published one. Null for a
    // version that was stored and never published.
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionUniq: uniqueIndex("steering_versions_version_uq").on(
      t.workspaceId,
      t.repository,
      t.version,
    ),
    commitIdx: index("steering_versions_commit_idx").on(
      t.workspaceId,
      t.repository,
      t.commitSha,
    ),
    versionCheck: check(
      "steering_versions_version_check",
      sql`${t.version} >= 1`,
    ),
    commitCheck: check(
      "steering_versions_commit_check",
      sql`${t.commitSha} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
  }),
);

export const steeringPublications = agentSchema.table(
  "steering_publications",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    repository: text("repository").notNull(),
    // The published version and its merge commit, both null before the first.
    publishedVersion: integer("published_version"),
    publishedCommit: text("published_commit"),
    // The published version's ledger line.
    ledger: jsonb("ledger"),
    // The publish lease. A publish holds it while `lease_until` is in the
    // future, and it lapses on its own when a process dies holding it.
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    repositoryUniq: uniqueIndex("steering_publications_repository_uq").on(
      t.workspaceId,
      t.repository,
    ),
    pointerCheck: check(
      "steering_publications_pointer_check",
      sql`(${t.publishedVersion} IS NULL) = (${t.publishedCommit} IS NULL)`,
    ),
    leaseCheck: check(
      "steering_publications_lease_check",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
  }),
);
