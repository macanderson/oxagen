// create_org against a real Postgres: a signed-in user with no memberships
// creates an organization and, in one call, holds the owner membership, the
// IAM bootstrap, the first workspace and the $5 signup grant, and no other
// billing.* row exists for the new org. With `workspace: null` it makes no
// workspace, and the org's first create_workspace takes the onboarding gate
// (#4582). Runs wherever DATABASE_URL points at a migrated database. CI's
// `test` job migrates Postgres with Atlas before `turbo run build test:unit`
// and carries DATABASE_URL in turbo's globalEnv. A local run without one is
// skipped. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { ORG_ONLY_WORKSPACE_ID, type CapabilityContext } from "@oxagen/oxagen";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray, sql } from "drizzle-orm";
import { organizationCreateHandler } from "./org.create";
import { initialSteeringRepoState } from "./steering_repo.provision";
import {
  createWorkspaceCreateHandler,
  type WorkspaceCreateDeps,
} from "./workspace.create";

const mocks = vi.hoisted(() => ({
  send: vi.fn(
    async (_event: { name: string; data: unknown }): Promise<void> =>
      undefined,
  ),
}));

// create_org starts two steering repo provision jobs (#4450) through the
// event client. The spy stands in for Inngest, so the test needs no live
// event key and can read what was sent.
vi.mock("./event-client", () => ({ eventClient: { send: mocks.send } }));

// create_workspace takes its provision request as a dependency, so the
// welcome-flow test hands it a spy instead of Inngest.
const requestProvision = vi.fn<WorkspaceCreateDeps["requestProvision"]>(
  async () => {},
);
const workspaceCreateHandler = createWorkspaceCreateHandler({
  requestProvision,
});

// The bootstrap test makes ~15 sequential round trips to Postgres plus one per
// billing table; under `test:coverage` on a shared CI runner that ran past the
// 5s default. Match schema.setup.test.ts's per-file budget.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
          .delete(schema.creditLots)
          .where(eq(schema.creditLots.orgId, orgId));
        await tx
          .delete(schema.creditLedger)
          .where(eq(schema.creditLedger.orgId, orgId));
        await tx
          .delete(schema.creditBalances)
          .where(eq(schema.creditBalances.orgId, orgId));
        await tx
          .delete(schema.onboardingState)
          .where(eq(schema.onboardingState.orgId, orgId));
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

  // create_org runs the whole IAM and workspace bootstrap in one system
  // transaction; under coverage, with the other pg files bootstrapping
  // organizations over the same shared IAM rows, it outlasts vitest's 5s
  // default.
  //
  // Every withSystemDb call is its own BEGIN + set_config + COMMIT, so the
  // verification reads are batched into as few transactions as the assertions
  // allow: the pre-check, then one snapshot transaction that collects the whole
  // bootstrap and the billing sweep. Read one assertion at a time — and once
  // per billing table — this test opened ~25 transactions and tipped over
  // vitest's 5s default on a loaded CI runner. The explicit timeout is the
  // second guard: this is a DB-bound integration test and the 5s default is
  // tuned for unit tests.
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
    expect(out.workspace?.slug).toBe("core");

    const snapshot = await withSystemDb(async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(schema.organizations.slug, slug),
      });
      if (!org) return { org: null } as const;

      // Owner membership.
      const memberships = await tx
        .select({ orgId: schema.orgUsers.orgId, role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(eq(schema.orgUsers.userId, userId));

      // IAM bootstrap: the creator's human principal holds the org Owner role.
      const ownerAssignments = await tx
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
        .where(eq(schema.principals.parentUserId, userId));
      const grants = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.roleGrants)
        .where(eq(schema.roleGrants.orgId, org.id));

      // First workspace with the creator as owner, its default environment
      // and default registry.
      const workspaces = await tx
        .select({
          id: schema.workspaces.id,
          publicId: schema.workspaces.publicId,
          slug: schema.workspaces.slug,
          namespace: schema.workspaces.namespace,
          settings: schema.workspaces.settings,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, org.id));
      const wsId = workspaces[0]?.id;
      const wsMembers = wsId
        ? await tx
            .select({
              userId: schema.workspaceUsers.userId,
              role: schema.workspaceUsers.role,
            })
            .from(schema.workspaceUsers)
            .where(eq(schema.workspaceUsers.workspaceId, wsId))
        : [];
      const environments = wsId
        ? await tx
            .select({ isDefault: schema.environments.isDefault })
            .from(schema.environments)
            .where(eq(schema.environments.workspaceId, wsId))
        : [];
      const registries = wsId
        ? await tx
            .select({ isDefault: schema.mcpRegistries.isDefault })
            .from(schema.mcpRegistries)
            .where(eq(schema.mcpRegistries.workspaceId, wsId))
        : [];

      // Every billing.* table keyed by org_id, counted for the new org: the
      // signup grant's three tables hold one row each and the rest hold
      // none (asserted below). Enumerated from the catalog so a table added
      // later (contract_terms, gau_buckets, gau_settlements) is covered
      // without an edit here, and counted in one UNION ALL rather than one
      // round trip per table.
      const billingTables = await tx.execute<{ table_name: string }>(sql`
          select table_name from information_schema.columns
          where table_schema = 'billing' and column_name = 'org_id'
          order by table_name
        `);
      const names = [...billingTables].map((r) => r.table_name);
      const billingCounts =
        names.length === 0
          ? []
          : [
              ...(await tx.execute<{ table_name: string; n: number }>(
                sql.join(
                  names.map(
                    (name) =>
                      sql`select ${name}::text as table_name, count(*)::int as n from billing.${sql.identifier(name)} where org_id = ${org.id}`,
                  ),
                  sql` union all `,
                ),
              )),
            ];

      return {
        org,
        memberships,
        ownerAssignments,
        grants,
        workspaces,
        wsMembers,
        environments,
        registries,
        names,
        billingCounts,
      } as const;
    });

    expect(snapshot.org).not.toBeNull();
    if (snapshot.org === null) return;
    const org = snapshot.org;
    createdOrgIds.push(org.id);
    expect(org.publicId).toBe(out.publicId);
    // The namespace is derived server-side from the slug.
    expect(org.namespace).toMatch(/^[a-z0-9]{2,6}$/);
    expect(org.createdById).toBe(userId);

    expect(snapshot.memberships).toEqual([{ orgId: org.id, role: "owner" }]);
    expect(snapshot.ownerAssignments).toEqual([
      { role: "Owner", kind: "human" },
    ]);
    expect(snapshot.grants[0]?.n).toBeGreaterThan(0);

    expect(snapshot.workspaces).toHaveLength(1);
    const ws = snapshot.workspaces[0]!;
    expect(ws.publicId).toBe(out.workspace?.publicId);
    expect(ws.slug).toBe("core");
    expect(ws.namespace).toMatch(/^[a-z0-9]{2,6}$/);
    expect(snapshot.wsMembers).toEqual([{ userId, role: "owner" }]);
    expect(snapshot.environments).toEqual([{ isDefault: true }]);
    expect(snapshot.registries).toEqual([{ isDefault: true }]);

    // The organization and its first workspace each hold the first state of
    // their steering repo, timed from the organization's creation (#4450).
    const firstState = initialSteeringRepoState(org.createdAt);
    expect(firstState).toMatchObject({
      status: "provisioning",
      step: null,
      failed_step: null,
      error: null,
      attempt: 1,
    });
    expect(org.settings).toMatchObject({ steering_repo: firstState });
    expect(ws.settings).toMatchObject({ steering_repo: firstState });

    // One provision request for the organization repo and one for the
    // workspace's own, sent after the transaction committed.
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "steering-repo/provision.requested",
      data: { orgId: org.id, workspaceId: null, actorUserId: userId },
    });
    expect(mocks.send).toHaveBeenCalledWith({
      name: "steering-repo/provision.requested",
      data: { orgId: org.id, workspaceId: ws.id, actorUserId: userId },
    });

    // The $5 signup grant and nothing else billing-shaped: the grant's
    // ledger row, lot and balance mirror hold one row each, and every other
    // billing.* table keyed by org_id has no row for the new org. Enumerated
    // from the catalog (inside the snapshot transaction) so a table added
    // later (contract_terms, gau_buckets, gau_settlements) is covered
    // without an edit here. The one-time governed-action grant (ADR-NEW,
    // #4886) is the fourth: one gau_signup_grants row.
    const GRANT_TABLES = new Set([
      "credit_balances",
      "credit_ledger",
      "credit_lots",
      "gau_signup_grants",
    ]);
    for (const required of [
      "credit_balances",
      "credit_ledger",
      "credit_lots",
      "gau_signup_grants",
      "org_billing_settings",
    ]) {
      expect(snapshot.names, required).toContain(required);
    }
    const counted = new Map(
      snapshot.billingCounts.map((r) => [r.table_name, r.n]),
    );
    for (const name of snapshot.names) {
      expect(counted.get(name), `billing.${name}`).toBe(
        GRANT_TABLES.has(name) ? 1 : 0,
      );
    }
    const [lot] = await withSystemDb((tx) =>
      tx
        .select({
          source: schema.creditLots.source,
          remainingCents: schema.creditLots.remainingCents,
          expiresAt: schema.creditLots.expiresAt,
        })
        .from(schema.creditLots)
        .where(eq(schema.creditLots.orgId, org.id)),
    );
    expect(lot).toEqual({
      source: "free_grant",
      remainingCents: 500n,
      expiresAt: null,
    });
    // The IAM bootstrap seeds role_grants one insert per capability role
    // (iam-provision.ts step d): 3.8 s on a loaded CI runner at app-rebuild
    // 340420f10 and past the 5 s default on the next two runs. The rollback
    // assertions then add a dozen-plus more round trips, one per billing
    // table, against a Postgres shared with every other *.pg.test.ts under
    // coverage — so the 5 s default timed out with no assertion failing.
  }, 30_000);

  it("refuses a second organization on the same slug", async () => {
    const sentBefore = mocks.send.mock.calls.length;
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
    // A refused organization starts no provision job.
    expect(mocks.send.mock.calls.length).toBe(sentBefore);
  });

  // The web app's welcome flow (#4582). The app sends `workspace: null`, so
  // create_org makes no workspace and opens the gate with none. The welcome
  // step then calls create_workspace from an org-only scope, the same scope
  // the app kernel uses, and that first workspace takes the gate. A second
  // workspace leaves it alone.
  it("opens the gate with no workspace on `workspace: null`, and the first create_workspace takes it", async () => {
    const nullSlug = `wl16n-${tag}`;
    const sentBefore = mocks.send.mock.calls.length;
    const out = await organizationCreateHandler(
      organizationCreate.input.parse({
        name: `WL16 null ${tag}`,
        slug: nullSlug,
        workspace: null,
      }),
      ctx,
    );
    expect(organizationCreate.output.safeParse(out).success).toBe(true);
    expect(out.workspace).toBeNull();

    const org = await withSystemDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.slug, nullSlug),
        columns: { id: true },
      }),
    );
    expect(org).toBeDefined();
    if (!org) return;
    createdOrgIds.push(org.id);

    const readGate = () =>
      withSystemDb((tx) =>
        tx
          .select({
            workspaceId: schema.onboardingState.workspaceId,
            step: schema.onboardingState.step,
          })
          .from(schema.onboardingState)
          .where(eq(schema.onboardingState.orgId, org.id)),
      );
    const workspacesOf = () =>
      withSystemDb((tx) =>
        tx
          .select({
            id: schema.workspaces.id,
            publicId: schema.workspaces.publicId,
          })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, org.id)),
      );

    expect(await workspacesOf()).toEqual([]);
    expect(await readGate()).toEqual([{ workspaceId: null, step: "wrap" }]);
    // Only the organization's steering repo job starts.
    expect(mocks.send.mock.calls.slice(sentBefore)).toEqual([
      [
        {
          name: "steering-repo/provision.requested",
          data: { orgId: org.id, workspaceId: null, actorUserId: userId },
        },
      ],
    ]);

    const orgOnly = { orgId: org.id, workspaceId: ORG_ONLY_WORKSPACE_ID };
    const orgCtx: CapabilityContext = { ...ctx, ...orgOnly };
    const createIn = (name: string, slug: string) =>
      runInTenantScope(orgOnly, () =>
        workspaceCreateHandler(
          workspaceCreate.input.parse({ name, slug }),
          orgCtx,
        ),
      );

    const first = await createIn("Core", "core");
    const [firstRow] = (await workspacesOf()).filter(
      (w) => w.publicId === first.publicId,
    );
    expect(firstRow).toBeDefined();
    expect(await readGate()).toEqual([
      { workspaceId: firstRow?.id, step: "wrap" },
    ]);

    await createIn("Data", "data");
    expect(await workspacesOf()).toHaveLength(2);
    expect(await readGate()).toEqual([
      { workspaceId: firstRow?.id, step: "wrap" },
    ]);
    expect(requestProvision).toHaveBeenCalledTimes(2);
  }, 30_000);
});
