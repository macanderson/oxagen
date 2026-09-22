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
type SkillConfigRow = typeof schema.skillConfigVersions.$inferSelect;
export interface SkillConfigStore {
  list(scope: SkillScope): Promise<PublishedSkillConfig[]>;
  publish(
    scope: SkillScope,
    snapshot: NewSkillConfig,
  ): Promise<PublishedSkillConfig>;
}
/** The newest version a binding holds, by publication time then by insertion. */
function headOf(rows: SkillConfigRow[]): SkillConfigRow | undefined {
  return [...rows].sort(
    (a, b) =>
      b.publishedAt.getTime() - a.publishedAt.getTime() ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
}
/**
 * Decide what a publication does to a binding's history: reuse a recorded
 * version, or append one when the return is null. The rules are pure over the
 * rows a workspace holds, so a test can prove them without a database.
 *
 * A commit already on record is a retry and reuses its row, and the same
 * commit carrying different bytes is a conflict. Identical bytes at a new
 * commit are a new publication, because the pull request that merged them is
 * the authority the record names, and reusing the earlier row would credit a
 * review that did not carry this change.
 *
 * A publication the binding's head already outranks is refused, whether it
 * names a commit the record superseded or merged before the head merged. The
 * head is the version in force, so an earlier pull request is not the current
 * authority even when a later revert restored its bytes, and accepting it
 * would report a stale configuration as the one the workspace now runs.
 */
export function resolvePublication(
  rows: SkillConfigRow[],
  snapshot: NewSkillConfig,
): SkillConfigRow | null {
  const binding = rows.filter(
    (row) => row.repositoryBindingId === snapshot.repositoryBindingId,
  );
  const superseded = () =>
    new HandlerError({
      code: "conflict",
      reason: "skill_config_superseded",
      message:
        "A later configuration version is already published for this repository. Publish the pull request that carries the current configuration.",
    });
  const head = headOf(binding);
  const existing = binding.find((row) => row.commitSha === snapshot.commitSha);
  if (existing) {
    if (existing.configDigest !== snapshot.digest)
      throw new HandlerError({
        code: "conflict",
        reason: "skill_config_digest_changed",
        message:
          "The published commit no longer matches its recorded configuration",
      });
    if (existing.id !== head?.id) throw superseded();
    return existing;
  }
  if (snapshot.pullRequestNumber === null && binding.length > 0)
    throw new HandlerError({
      code: "conflict",
      reason: "skill_config_already_imported",
      message:
        "Later configuration versions must name the pull request that published them",
    });
  if (head && Date.parse(snapshot.publishedAt) < head.publishedAt.getTime())
    throw superseded();
  return null;
}
function view(row: SkillConfigRow): PublishedSkillConfig {
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
      const reused = resolvePublication(rows, snapshot);
      if (reused) return view(reused);
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
