// The database half of /github/setup. Every query is filtered to the signed-in
// user's own org memberships: this runs before any tenant scope exists (the user
// may belong to many orgs), so it reads through withSystemDb and the membership
// filter is the security boundary — it can never land someone in a workspace of
// an org they are not a member of.
import "server-only";
import { isFixtureMode } from "@/server/fixture-session";
import {
  FIXTURE_HOME_WORKSPACE as FIXTURE_WORKSPACE,
  FIXTURE_ORG,
} from "@/server/fixture-tenancy";
import type { GithubSetupQueries, GithubSetupTargetRow } from "./github-setup";

const fixtureQueries: GithubSetupQueries = {
  matchInstallation: () => Promise.resolve([]),
  mostRecentMembership: () =>
    Promise.resolve([
      { orgSlug: FIXTURE_ORG.slug, workspaceSlug: FIXTURE_WORKSPACE.slug },
    ]),
};

function installationOf(deliveryConfig: unknown): string | null {
  if (deliveryConfig === null || typeof deliveryConfig !== "object")
    return null;
  const value = (deliveryConfig as { installationId?: unknown }).installationId;
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

const liveQueries: GithubSetupQueries = {
  async matchInstallation(userId, installationId) {
    const { withSystemDb } = await import("@oxagen/database");
    // tenancy: unscoped seam (pre-scope landing; rows filtered to the user's memberships)
    return withSystemDb(async (tx): Promise<GithubSetupTargetRow[]> => {
      const memberships = await tx.query.orgUsers.findMany({
        where: (ou, { eq }) => eq(ou.userId, userId),
        columns: { orgId: true },
      });
      const orgIds = memberships.map((m) => m.orgId);
      if (orgIds.length === 0) return [];
      const connections = await tx.query.sourceConnections.findMany({
        where: (c, { and, eq, inArray, isNull }) =>
          and(
            eq(c.connectorId, "github"),
            inArray(c.orgId, orgIds),
            isNull(c.deletedAt),
          ),
        columns: {
          orgId: true,
          workspaceId: true,
          deliveryConfig: true,
          updatedAt: true,
        },
        orderBy: (c, { desc }) => [desc(c.updatedAt)],
      });
      const hit = connections.find(
        (c) => installationOf(c.deliveryConfig) === installationId,
      );
      if (!hit) return [];
      const [org, workspace] = await Promise.all([
        tx.query.organizations.findFirst({
          where: (o, { and, eq, ne }) =>
            and(eq(o.id, hit.orgId), ne(o.status, "deleted")),
          columns: { slug: true },
        }),
        tx.query.workspaces.findFirst({
          where: (w, { and, eq }) =>
            and(eq(w.id, hit.workspaceId), eq(w.orgId, hit.orgId)),
          columns: { slug: true },
        }),
      ]);
      return org
        ? [{ orgSlug: org.slug, workspaceSlug: workspace?.slug ?? null }]
        : [];
    });
  },

  async mostRecentMembership(userId) {
    const { withSystemDb } = await import("@oxagen/database");
    // tenancy: unscoped seam (pre-scope landing; rows filtered to the user's memberships)
    return withSystemDb(async (tx): Promise<GithubSetupTargetRow[]> => {
      const memberships = await tx.query.orgUsers.findMany({
        where: (ou, { eq }) => eq(ou.userId, userId),
        columns: { orgId: true },
        orderBy: (ou, { desc }) => [desc(ou.joinedAt)],
      });
      for (const { orgId } of memberships) {
        const org = await tx.query.organizations.findFirst({
          where: (o, { and, eq, ne }) =>
            and(eq(o.id, orgId), ne(o.status, "deleted")),
          columns: { slug: true },
        });
        if (!org) continue;
        const workspace = await tx.query.workspaces.findFirst({
          where: (w, { eq }) => eq(w.orgId, orgId),
          columns: { slug: true },
        });
        return [{ orgSlug: org.slug, workspaceSlug: workspace?.slug ?? null }];
      }
      return [];
    });
  },
};

export function githubSetupQueries(): GithubSetupQueries {
  return isFixtureMode() ? fixtureQueries : liveQueries;
}
