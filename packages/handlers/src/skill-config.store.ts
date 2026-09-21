import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { HandlerError } from "@oxagen/oxagen";
import { skillConfigSchema, type SkillConfig } from "@oxagen/oxagen/skills";

export type SkillScope = {
  orgId: string;
  workspaceId: string;
  userId?: string | null;
};
export type PublishedSkillConfig = {
  id: string;
  version: string;
  repositoryBindingId: string;
  commitSha: string;
  pullRequestNumber: number | null;
  digest: string;
  config: SkillConfig;
  publishedAt: string;
};
export type NewSkillConfig = Omit<PublishedSkillConfig, "id" | "version">;
export interface SkillConfigStore {
  list(scope: SkillScope): Promise<PublishedSkillConfig[]>;
  publish(
    scope: SkillScope,
    snapshot: NewSkillConfig,
  ): Promise<PublishedSkillConfig>;
}
function view(
  row: typeof schema.skillConfigVersions.$inferSelect,
): PublishedSkillConfig {
  return {
    id: row.publicId,
    version: row.versionLabel,
    repositoryBindingId: row.repositoryBindingId,
    commitSha: row.commitSha,
    pullRequestNumber: row.pullRequestNumber,
    digest: row.configDigest,
    config: skillConfigSchema.parse({
      enabled: row.enabled,
      sources: row.sources,
      search: row.search,
      unbound_repo: row.unboundRepo,
      reflection: row.reflection,
    }),
    publishedAt: row.publishedAt.toISOString(),
  };
}
export const postgresSkillConfigStore: SkillConfigStore = {
  list: (scope) =>
    withTenantDb(async (tx) => {
      const t = schema.skillConfigVersions;
      return (
        await tx
          .select()
          .from(t)
          .where(
            and(eq(t.orgId, scope.orgId), eq(t.workspaceId, scope.workspaceId)),
          )
          .orderBy(desc(t.publishedAt), desc(t.createdAt))
      ).map(view);
    }),
  publish: (scope, snapshot) =>
    withTenantDb(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`skills:${scope.orgId}:${scope.workspaceId}`}, 0))`,
      );
      const heads = schema.repositoryBindingHeads;
      const connections = schema.sourceConnections;
      const [bound] = await tx
        .select({ id: heads.id })
        .from(heads)
        .innerJoin(connections, eq(connections.id, heads.connectionId))
        .where(
          and(
            eq(heads.orgId, scope.orgId),
            eq(heads.workspaceId, scope.workspaceId),
            eq(heads.role, "main"),
            eq(heads.currentBindingId, snapshot.repositoryBindingId),
            eq(connections.orgId, scope.orgId),
            eq(connections.workspaceId, scope.workspaceId),
            isNull(connections.deletedAt),
            notInArray(connections.status, ["deleting", "deleted"]),
          ),
        )
        .for("share");
      if (!bound)
        throw new HandlerError({
          code: "conflict",
          reason: "skill_repository_changed",
          message: "The main repository binding changed during publication",
        });
      const t = schema.skillConfigVersions;
      const rows = await tx
        .select()
        .from(t)
        .where(
          and(eq(t.orgId, scope.orgId), eq(t.workspaceId, scope.workspaceId)),
        );
      const existing = rows.find(
        (row) =>
          row.repositoryBindingId === snapshot.repositoryBindingId &&
          row.commitSha === snapshot.commitSha,
      );
      if (existing) {
        if (existing.configDigest !== snapshot.digest)
          throw new HandlerError({
            code: "conflict",
            reason: "skill_config_digest_changed",
            message:
              "The published commit no longer matches its recorded configuration",
          });
        return view(existing);
      }
      if (
        snapshot.pullRequestNumber === null &&
        rows.some(
          (row) => row.repositoryBindingId === snapshot.repositoryBindingId,
        )
      ) {
        throw new HandlerError({
          code: "conflict",
          reason: "skill_config_already_imported",
          message:
            "Later configuration versions must name the pull request that published them",
        });
      }
      const previous = rows
        .filter(
          (row) => row.repositoryBindingId === snapshot.repositoryBindingId,
        )
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0];
      if (previous?.configDigest === snapshot.digest) return view(previous);
      const [row] = await tx
        .insert(t)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          createdById: scope.userId,
          versionLabel: `skl_v${rows.length + 1}`,
          repositoryBindingId: snapshot.repositoryBindingId,
          commitSha: snapshot.commitSha,
          pullRequestNumber: snapshot.pullRequestNumber,
          enabled: snapshot.config.enabled,
          configDigest: snapshot.digest,
          sources: snapshot.config.sources,
          search: snapshot.config.search,
          unboundRepo: snapshot.config.unbound_repo,
          reflection: snapshot.config.reflection,
          publishedAt: new Date(snapshot.publishedAt),
        })
        .returning();
      if (!row)
        throw new HandlerError({
          code: "conflict",
          reason: "skill_config_insert_failed",
          message: "The configuration snapshot could not be recorded",
        });
      return view(row);
    }),
};
