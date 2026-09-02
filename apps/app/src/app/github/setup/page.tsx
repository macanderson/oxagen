import "server-only";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { getSession } from "@/lib/session";
import {
  resolveGithubSetupTarget,
  type GithubSetupQueries,
} from "./resolve-target";

type GithubSetupSearchParams = {
  installation_id?: string;
  setup_action?: string;
};

/**
 * GitHub App "Setup URL" landing route — `/github/setup`.
 *
 * GitHub redirects a browser here after a user CONFIGURES an existing
 * installation on github.com (adds/removes repos) — the App's "Redirect on
 * update" target. Unlike the initial-install leg (which, with "Request user
 * authorization during installation" enabled, hits the API callback
 * `/oauth/github/callback` with a signed OAuth `state`), this redirect carries
 * only `installation_id` + `setup_action` and NO `state`, so it cannot be
 * attributed to a workspace from the URL alone.
 *
 * The same GitHub App installation can back source connections in many tenants
 * and workspaces — even the same repository across different tenants. We send
 * the user to the MOST RECENTLY INSTALLED workspace/tenant they have access to:
 * the matching connection ordered by `updated_at DESC` (the OAuth callback
 * stamps `updated_at` when it attaches the installation id), gated to orgs the
 * signed-in user is a member of.
 *
 * Security: this route runs BEFORE any tenant scope exists (the user may belong
 * to many orgs), so it uses `withSystemDb` (RLS-bypassing) but EXPLICITLY joins
 * `org_users` on the session user — it can never redirect a user into a
 * workspace they are not a member of. Same deliberate pattern as the root page:
 * the app does not bootstrap IAM, so the gate lives here.
 */
const dbQueries: GithubSetupQueries = {
  matchInstallation: (userId, installationId) =>
    withSystemDb((tx) =>
      tx
        .select({
          orgSlug: schema.organizations.slug,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.sourceConnections)
        // Membership gate: only orgs this user belongs to.
        .innerJoin(
          schema.orgUsers,
          and(
            eq(schema.orgUsers.orgId, schema.sourceConnections.orgId),
            eq(schema.orgUsers.userId, userId),
          ),
        )
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.sourceConnections.orgId),
        )
        .innerJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.sourceConnections.workspaceId),
            eq(schema.workspaces.orgId, schema.sourceConnections.orgId),
          ),
        )
        .where(
          and(
            eq(schema.sourceConnections.connectorId, "github"),
            sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId' = ${installationId}`,
            isNull(schema.sourceConnections.deletedAt),
            sql`${schema.organizations.status} <> 'deleted'`,
          ),
        )
        // Most recently installed first — the install stamps updated_at.
        .orderBy(desc(schema.sourceConnections.updatedAt))
        .limit(1),
    ),

  mostRecentMembership: (userId) =>
    withSystemDb((tx) =>
      tx
        .select({
          orgSlug: schema.organizations.slug,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.orgUsers)
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.orgUsers.orgId),
        )
        .leftJoin(
          schema.workspaces,
          eq(schema.workspaces.orgId, schema.organizations.id),
        )
        .where(
          and(
            eq(schema.orgUsers.userId, userId),
            sql`${schema.organizations.status} <> 'deleted'`,
          ),
        )
        .orderBy(desc(schema.orgUsers.joinedAt))
        .limit(1),
    ),
};

export default async function GithubSetupPage({
  searchParams,
}: {
  searchParams: Promise<GithubSetupSearchParams>;
}) {
  const session = await getSession();
  if (!session?.user) redirect("/login");

  const { installation_id: installationId } = await searchParams;

  const target = await resolveGithubSetupTarget(
    session.user.id,
    installationId,
    dbQueries,
  );

  redirect(target);
}
