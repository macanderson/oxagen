// create_org against a real Postgres: a signed-in user with no memberships
// creates an organization and, in one call, holds the owner membership, the
// IAM bootstrap and the first workspace, and no billing.* row exists for the
// new org. Runs wherever DATABASE_URL points at a migrated database — CI's
// `test` job migrates Postgres with Atlas before `turbo run build test:unit`
// and carries DATABASE_URL in turbo's globalEnv; a local run without one is
// skipped, not red. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import type { CapabilityContext } from "@oxagen/oxagen";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, inArray, sql } from "drizzle-orm";
import { organizationCreateHandler } from "./org.create";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("create_org against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const userId = crypto.randomUUID();
  const slug = `wl16-${tag}`;
  const ctx: CapabilityContext = {
    orgId: "",
    workspaceId: "",
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  };
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    await withSystemDb((tx) =>
      tx.insert(schema.users).values({
        id: userId,
        email: `wl16-${tag}@handlers.test`,
        status: "active",
      }),
    );
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      for (const orgId of createdOrgIds) {
        const agentIds = (
          await tx
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(eq(schema.agents.orgId, orgId))
        ).map((r) => r.id);
        if (agentIds.length > 0) {
          await tx
            .delete(schema.agentVersions)
            .where(inArray(schema.agentVersions.agentId, agentIds));
        }
        const workspaceIds = (
          await tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, orgId))
        ).map((r) => r.id);
        if (workspaceIds.length > 0) {
          await tx
            .delete(schema.workspaceUsers)
            .where(inArray(schema.workspaceUsers.workspaceId, workspaceIds));
        }
        await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
        await tx
          .delete(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.orgId, orgId));
        await tx
          .delete(schema.environments)
          .where(eq(schema.environments.orgId, orgId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId));
        await tx
          .delete(schema.roleGrants)
          .where(eq(schema.roleGrants.orgId, orgId));
        await tx
          .delete(schema.principalRoleAssignments)
          .where(eq(schema.principalRoleAssignments.orgId, orgId));
        await tx
          .delete(schema.principals)
          .where(eq(schema.principals.orgId, orgId));
        await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
        await tx
          .delete(schema.securityEvents)
          .where(eq(schema.securityEvents.orgId, orgId));
        await tx
          .delete(schema.orgUsers)
          .where(eq(schema.orgUsers.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      }
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
    await closeDatabase();
  });

  it("bootstraps the org, the owner membership, IAM and the first workspace in one call, and writes no billing row", async () => {
    const before = await withSystemDb((tx) =>
      tx
        .select({ id: schema.orgUsers.id })
        .from(schema.orgUsers)
        .where(eq(schema.orgUsers.userId, userId)),
    );
    expect(before).toHaveLength(0);

    const out = await organizationCreateHandler(
      organizationCreate.input.parse({
        name: `WL16 ${tag}`,
        slug,
        workspace: { name: "Core", slug: "core" },
      }),
      ctx,
    );
    expect(organizationCreate.output.safeParse(out).success).toBe(true);
    expect(out.slug).toBe(slug);
    expect(out.workspace.slug).toBe("core");

    const org = await withSystemDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.slug, slug),
      }),
    );
    expect(org).toBeDefined();
    if (!org) return;
    createdOrgIds.push(org.id);
    expect(org.publicId).toBe(out.publicId);
    // The namespace is derived server-side from the slug.
    expect(org.namespace).toMatch(/^[a-z0-9]{2,6}$/);
    expect(org.createdByUserId).toBe(userId);

    // Owner membership.
    const memberships = await withSystemDb((tx) =>
      tx
        .select({ orgId: schema.orgUsers.orgId, role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(eq(schema.orgUsers.userId, userId)),
    );
    expect(memberships).toEqual([{ orgId: org.id, role: "owner" }]);

    // IAM bootstrap: the creator's human principal holds the org Owner role.
    const ownerAssignments = await withSystemDb((tx) =>
      tx
        .select({ role: schema.roles.name, kind: schema.principals.kind })
        .from(schema.principalRoleAssignments)
        .innerJoin(
          schema.roles,
          eq(schema.roles.id, schema.principalRoleAssignments.roleId),
        )
        .innerJoin(
          schema.principals,
          eq(schema.principals.id, schema.principalRoleAssignments.principalId),
        )
        .where(eq(schema.principals.parentUserId, userId)),
    );
    expect(ownerAssignments).toEqual([{ role: "Owner", kind: "human" }]);
    const grants = await withSystemDb((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.roleGrants)
        .where(eq(schema.roleGrants.orgId, org.id)),
    );
    expect(grants[0]?.n).toBeGreaterThan(0);

    // First workspace with the creator as owner, its default environment and
    // default registry.
    const workspaces = await withSystemDb((tx) =>
      tx
        .select({
          id: schema.workspaces.id,
          publicId: schema.workspaces.publicId,
          slug: schema.workspaces.slug,
          namespace: schema.workspaces.namespace,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, org.id)),
    );
    expect(workspaces).toHaveLength(1);
    const ws = workspaces[0]!;
    expect(ws.publicId).toBe(out.workspace.publicId);
    expect(ws.slug).toBe("core");
    expect(ws.namespace).toMatch(/^[a-z0-9]{2,6}$/);
    const wsMembers = await withSystemDb((tx) =>
      tx
        .select({
          userId: schema.workspaceUsers.userId,
          role: schema.workspaceUsers.role,
        })
        .from(schema.workspaceUsers)
        .where(eq(schema.workspaceUsers.workspaceId, ws.id)),
    );
    expect(wsMembers).toEqual([{ userId, role: "owner" }]);
    const environments = await withSystemDb((tx) =>
      tx
        .select({ isDefault: schema.environments.isDefault })
        .from(schema.environments)
        .where(eq(schema.environments.workspaceId, ws.id)),
    );
    expect(environments).toEqual([{ isDefault: true }]);
    const registries = await withSystemDb((tx) =>
      tx
        .select({ isDefault: schema.mcpRegistries.isDefault })
        .from(schema.mcpRegistries)
        .where(eq(schema.mcpRegistries.workspaceId, ws.id)),
    );
    expect(registries).toEqual([{ isDefault: true }]);

    // Nothing billing-shaped: every billing.* table keyed by org_id has no
    // row for the new org. Enumerated from the catalog so a table added later
    // (contract_terms, gau_buckets, gau_settlements) is covered without an
    // edit here.
    const billingTables = await withSystemDb((tx) =>
      tx.execute<{ table_name: string }>(sql`
        select table_name from information_schema.columns
        where table_schema = 'billing' and column_name = 'org_id'
        order by table_name
      `),
    );
    const names = [...billingTables].map((r) => r.table_name);
    for (const required of [
      "credit_balances",
      "credit_ledger",
      "credit_lots",
      "org_billing_settings",
    ]) {
      expect(names, required).toContain(required);
    }
    for (const name of names) {
      const rows = await withSystemDb((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from billing.${sql.identifier(name)} where org_id = ${org.id}`,
        ),
      );
      expect([...rows][0]?.n, `billing.${name}`).toBe(0);
    }
  });

  it("refuses a second organization on the same slug", async () => {
    await expect(
      organizationCreateHandler(
        organizationCreate.input.parse({ name: "Clone", slug }),
        ctx,
      ),
    ).rejects.toThrow(`slug "${slug}" already in use`);
    const count = await withSystemDb((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, slug)),
    );
    expect(count[0]?.n).toBe(1);
  });
});
