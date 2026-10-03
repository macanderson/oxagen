// steering_repo.provision.code-installation.pg.test.ts: the production
// attachCodeInstallation against a migrated database. bind_repository calls
// it with the steering installation. A workspace with no `github` connection
// gets one carrying that installation, so its code repositories list. A
// workspace that already has one keeps the installation it has.
//
// Runs wherever DATABASE_URL points at a migrated database, as CI's unit
// lanes do. A local run without one is skipped. afterAll removes every row
// the tests write.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";
import { steeringRepoProvisionDeps } from "./steering_repo.provision";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("attachCodeInstallation against Postgres", () => {
  const orgId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  /** A new workspace with no `github` connection. */
  const bareWorkspace = crypto.randomUUID();
  /** A workspace whose `github` connection already carries installation 555. */
  const connectedWorkspace = crypto.randomUUID();
  const workspaceIds = [bareWorkspace, connectedWorkspace];
  const tag = orgId.slice(0, 8);

  const attachOf = () => {
    const attach = steeringRepoProvisionDeps({
      actorUserId: userId,
      env: {},
    }).attachCodeInstallation;
    if (attach === undefined)
      throw new Error("the production deps carry no attachCodeInstallation");
    return attach;
  };

  /** The workspace's `github` connections, read past RLS. */
  const githubConnections = (workspaceId: string) =>
    withSystemDb((tx) =>
      tx
        .select({
          deliveryConfig: schema.sourceConnections.deliveryConfig,
          status: schema.sourceConnections.status,
          createdById: schema.sourceConnections.createdById,
        })
        .from(schema.sourceConnections)
        .where(
          and(
            eq(schema.sourceConnections.workspaceId, workspaceId),
            eq(schema.sourceConnections.connectorId, GITHUB_PROVIDER),
          ),
        ),
    );

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email: `code-install-${tag}@handlers.test`,
        displayName: "Dana Okafor",
        status: "active",
      });
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Code installation ${tag}`,
        slug: `code-install-${tag}`,
        namespace: `c${tag.slice(0, 5)}`,
        planType: "enterprise",
        status: "active",
      });
      await tx.insert(schema.workspaces).values([
        {
          id: bareWorkspace,
          orgId,
          name: "Core",
          slug: "core",
          namespace: "core",
        },
        {
          id: connectedWorkspace,
          orgId,
          name: "Docs",
          slug: "docs",
          namespace: "docs",
        },
      ]);
      // What the GitHub install callback or "Use this installation" leaves.
      await tx.insert(schema.sourceConnections).values({
        orgId,
        workspaceId: connectedWorkspace,
        connectorId: GITHUB_PROVIDER,
        displayName: "GitHub",
        authScheme: "oauth2_authorization_code",
        deliveryMethod: "webhook",
        deliveryConfig: { installationId: "555" },
        status: "pending_setup",
        createdById: userId,
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.sourceConnections)
        .where(eq(schema.sourceConnections.orgId, orgId));
      await tx
        .delete(schema.workspaceSlugHistory)
        .where(inArray(schema.workspaceSlugHistory.workspaceId, workspaceIds));
      await tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.orgId, orgId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
    await closeDatabase();
  });

  it("gives a workspace with no GitHub connection one that carries the steering installation", async () => {
    const attach = attachOf();
    await attach({ kind: "workspace", orgId, workspaceId: bareWorkspace }, 4242);

    expect(await githubConnections(bareWorkspace)).toEqual([
      {
        deliveryConfig: { installationId: "4242" },
        status: "pending_setup",
        createdById: userId,
      },
    ]);
    // The reader every code repository capability uses now finds it.
    await expect(
      runInTenantScope({ orgId, workspaceId: bareWorkspace }, () =>
        resolveWorkspaceGithubInstallation({
          orgId,
          workspaceId: bareWorkspace,
        }),
      ),
    ).resolves.toMatchObject({ installationId: "4242" });

    // A rerun of the bind step writes no second connection.
    await attach({ kind: "workspace", orgId, workspaceId: bareWorkspace }, 4242);
    expect(await githubConnections(bareWorkspace)).toHaveLength(1);
  });

  it("keeps the installation a workspace already has (negative)", async () => {
    const attach = attachOf();
    await attach(
      { kind: "workspace", orgId, workspaceId: connectedWorkspace },
      4242,
    );

    expect(await githubConnections(connectedWorkspace)).toEqual([
      {
        deliveryConfig: { installationId: "555" },
        status: "pending_setup",
        createdById: userId,
      },
    ]);
  });
});
