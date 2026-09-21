import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, sql } from "drizzle-orm";
import { postgresSkillConfigStore } from "./skill-config.store";
import { parseSkillConfig } from "./skill-resolution";

describe.skipIf(!process.env.DATABASE_URL)(
  "published skill configuration against Postgres",
  () => {
    const scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const otherWorkspaceId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    let repositoryBindingId: string;
    const within = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
    const snapshot = (
      sha: string,
      text = "enabled = true",
      pullRequestNumber: number | null = 12,
    ) => ({
      repositoryBindingId,
      commitSha: sha.repeat(40),
      pullRequestNumber,
      publishedAt: "2026-09-20T12:00:00.000Z",
      ...parseSkillConfig(text),
    });
    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.sourceConnections).values({
          id: connectionId,
          ...scope,
          connectorId: "github",
          displayName: "Skills test",
          authScheme: "github_app",
          deliveryMethod: "webhook",
          status: "connected",
        });
        const [binding] = await tx
          .insert(schema.repositoryBindings)
          .values({
            ...scope,
            connectionId,
            provider: "github",
            providerRepositoryId: connectionId,
            providerOwner: "owner",
            providerName: "repo",
            providerFullName: "owner/repo",
            configuredDefaultRef: "release",
            observedAt: new Date(),
            version: 1,
          })
          .returning();
        repositoryBindingId = binding!.id;
        await tx.insert(schema.repositoryBindingHeads).values({
          ...scope,
          connectionId,
          provider: "github",
          providerRepositoryId: connectionId,
          currentBindingId: repositoryBindingId,
          role: "main",
        });
      });
    });
    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.skillResolutions)
          .where(eq(schema.skillResolutions.orgId, scope.orgId));
        await tx
          .delete(schema.skillConfigVersions)
          .where(eq(schema.skillConfigVersions.orgId, scope.orgId));
        await tx
          .delete(schema.repositoryBindingHeads)
          .where(eq(schema.repositoryBindingHeads.orgId, scope.orgId));
        await tx
          .delete(schema.repositoryBindings)
          .where(eq(schema.repositoryBindings.orgId, scope.orgId));
        await tx
          .delete(schema.sourceConnections)
          .where(eq(schema.sourceConnections.id, connectionId));
      });
    });
    it("serializes concurrent publication into one immutable version", async () => {
      const rows = await Promise.all(
        Array.from({ length: 6 }, () =>
          within(() =>
            postgresSkillConfigStore.publish(
              scope,
              snapshot("a", "enabled = true", null),
            ),
          ),
        ),
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
      expect(rows[0]!.version).toBe("skl_v1");
      const later = await within(() =>
        postgresSkillConfigStore.publish(scope, {
          ...snapshot("b", "enabled = false"),
          publishedAt: "2026-09-20T13:00:00.000Z",
        }),
      );
      expect(later.version).toBe("skl_v2");
      const versions = await within(() => postgresSkillConfigStore.list(scope));
      expect(versions.map((row) => row.config.enabled)).toEqual([false, true]);
      await expect(
        within(() =>
          postgresSkillConfigStore.publish(
            scope,
            snapshot("a", "enabled = false", null),
          ),
        ),
      ).rejects.toMatchObject({ reason: "skill_config_digest_changed" });
      await expect(
        within(() =>
          postgresSkillConfigStore.publish(
            scope,
            snapshot("c", "enabled = true", null),
          ),
        ),
      ).rejects.toMatchObject({ reason: "skill_config_already_imported" });
      expect(
        await runInTenantScope(
          { ...scope, workspaceId: otherWorkspaceId },
          () =>
            postgresSkillConfigStore.list({
              ...scope,
              workspaceId: otherWorkspaceId,
            }),
        ),
      ).toEqual([]);
    });
    it("refuses publication after the main binding changes", async () => {
      await expect(
        within(() =>
          postgresSkillConfigStore.publish(scope, {
            ...snapshot("d"),
            repositoryBindingId: crypto.randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ reason: "skill_repository_changed" });
    });
    it("refuses a resolution that names another workspace's configuration", async () => {
      const [config] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.skillConfigVersions)
          .where(eq(schema.skillConfigVersions.orgId, scope.orgId))
          .limit(1),
      );
      await expect(
        withSystemDb((tx) =>
          tx.insert(schema.skillResolutions).values({
            ...scope,
            workspaceId: otherWorkspaceId,
            configVersionId: config!.id,
            runId: "run",
            attemptId: "attempt",
            skillId: "review",
            skillVersion: "1.0.0",
            skillDigest: `sha256:${"a".repeat(64)}`,
            source: "workspace",
            decision: "allowed",
            loaded: false,
            tokenCost: 0,
          }),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: "23503",
          constraint_name: "skill_resolutions_config_fk",
        },
      });
    });
    it.each(["configuration", "resolution"])(
      "widens only same-org reads, never %s inserts",
      async (target) => {
        const foreignOrgId = crypto.randomUUID();
        const config = parseSkillConfig("enabled = false");
        await expect(
          withSystemDb(async (tx) => {
            const seeded = await tx
              .insert(schema.skillConfigVersions)
              .values(
                [
                  scope,
                  { ...scope, workspaceId: otherWorkspaceId },
                  { orgId: foreignOrgId, workspaceId: crypto.randomUUID() },
                ].map((tenant) => ({
                  ...tenant,
                  versionLabel: "rls-witness",
                  repositoryBindingId,
                  commitSha: "e".repeat(40),
                  enabled: false,
                  configDigest: config.digest,
                  sources: config.config.sources,
                  search: config.config.search,
                  unboundRepo: config.config.unbound_repo,
                  reflection: config.config.reflection,
                  publishedAt: new Date(),
                })),
              )
              .returning();
            const resolution = (row: (typeof seeded)[number]) => ({
              orgId: row.orgId,
              workspaceId: row.workspaceId,
              configVersionId: row.id,
              runId: "rls-witness",
              attemptId: "attempt",
              skillId: "review",
              skillVersion: "1.0.0",
              skillDigest: config.digest,
              source: "workspace",
              decision: "allowed" as const,
              loaded: false,
              tokenCost: 0,
            });
            await tx
              .insert(schema.skillResolutions)
              .values(seeded.map(resolution));
            await tx.execute(sql`set local role oxagen_app`);
            await tx.execute(
              sql`select set_config('app.rls_bypass', 'off', true), set_config('app.org_wide', 'on', true), set_config('app.current_org_id', ${scope.orgId}, true), set_config('app.current_workspace_id', ${scope.workspaceId}, true)`,
            );
            const configs = await tx
              .select()
              .from(schema.skillConfigVersions)
              .where(
                eq(schema.skillConfigVersions.versionLabel, "rls-witness"),
              );
            const resolutions = await tx
              .select()
              .from(schema.skillResolutions)
              .where(eq(schema.skillResolutions.runId, "rls-witness"));
            for (const rows of [configs, resolutions]) {
              expect(rows).toHaveLength(2);
              expect(new Set(rows.map((row) => row.workspaceId))).toEqual(
                new Set([scope.workspaceId, otherWorkspaceId]),
              );
              expect(rows.every((row) => row.orgId === scope.orgId)).toBe(true);
            }
            if (target === "resolution")
              await tx
                .insert(schema.skillResolutions)
                .values(resolution(seeded[1]!));
            else
              await tx
                .insert(schema.skillConfigVersions)
                .values({
                  ...seeded[1]!,
                  id: crypto.randomUUID(),
                  publicId: `skv_${crypto.randomUUID()}`,
                  versionLabel: "refused",
                  commitSha: "f".repeat(40),
                });
          }),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
      },
    );
    it("enforces the append-only grants and RLS on the real tables", async () => {
      const rows = await withSystemDb(async (tx) =>
        tx.execute(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('oxagen_app', c.oid, 'SELECT') as can_select,
        has_table_privilege('oxagen_app', c.oid, 'INSERT') as can_insert,
        has_table_privilege('oxagen_app', c.oid, 'UPDATE') as can_update,
        has_table_privilege('oxagen_app', c.oid, 'DELETE') as can_delete,
        has_table_privilege('oxagen_app', c.oid, 'TRUNCATE') as can_truncate
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='skills' and c.relkind='r'
    `),
      );
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
          can_select: true,
          can_insert: true,
          can_update: false,
          can_delete: false,
          can_truncate: false,
        });
      const hidden = await withSystemDb(async (tx) => {
        await tx.execute(sql`set local role oxagen_app`);
        await tx.execute(
          sql`select set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', ${scope.orgId}, true), set_config('app.current_workspace_id', ${otherWorkspaceId}, true)`,
        );
        return tx.select().from(schema.skillConfigVersions);
      });
      expect(hidden).toEqual([]);
    });
  },
);
