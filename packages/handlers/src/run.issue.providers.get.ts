import type { CapabilityHandler } from "@oxagen/oxagen";
import { runIssueProvidersGet } from "@oxagen/oxagen/contracts/run.issue.providers.get";
import { assertCallerRole } from "./lib/capability-role-guard";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, arrayContains, or, sql } from "drizzle-orm";
import {
  linearOAuthConfigured,
  linearGraphql,
  resolveLinearIssueToken,
} from "@oxagen/plugins/run-outcomes-linear";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";
import { envGithubUrls } from "./repository.main.get";
import { z } from "zod";

const teamsSchema = z.object({
  teams: z.object({
    nodes: z.array(
      z.object({ id: z.string().uuid(), name: z.string(), key: z.string() }),
    ),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});
export const handler: CapabilityHandler<typeof runIssueProvidersGet> = async (
  input,
  ctx,
) => {
  await assertCallerRole(runIssueProvidersGet, ctx);
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const github = await resolveWorkspaceGithubInstallation(scope);
  const urls = envGithubUrls.githubUrls(scope);
  const connections = await withTenantDb((tx) =>
    tx
      .select({
        connectionId: schema.sourceConnections.publicId,
        name: schema.sourceConnections.displayName,
      })
      .from(schema.sourceConnections)
      .innerJoin(
        schema.oauthTokens,
        eq(schema.oauthTokens.connectionId, schema.sourceConnections.id),
      )
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          eq(schema.sourceConnections.connectorId, "linear"),
          sql`${schema.sourceConnections.deliveryConfig}->>'runOutcomesOnly' = 'true'`,
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
          arrayContains(schema.oauthTokens.scopes, ["read"]),
          or(
            arrayContains(schema.oauthTokens.scopes, ["issues:create"]),
            arrayContains(schema.oauthTokens.scopes, ["write"]),
          ),
        ),
      ),
  );
  let teams: z.output<typeof teamsSchema>["teams"] = {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  if (input.linearConnectionId) {
    const token = await resolveLinearIssueToken(
      scope,
      input.linearConnectionId,
    );
    teams = (
      await linearGraphql(
        scope,
        token,
        "query($after:String){teams(first:50,after:$after){nodes{id name key} pageInfo{hasNextPage endCursor}}}",
        { after: input.after ?? null },
        teamsSchema,
      )
    ).teams;
  }
  return {
    github: {
      connected: github?.status === "connected",
      connectUrl: urls?.connectUrl ?? null,
      installUrl: urls?.installUrl ?? null,
      manageUrl: urls?.manageUrl ?? null,
    },
    linear: {
      configured: linearOAuthConfigured(),
      connections,
      teams: teams.nodes,
      ...teams.pageInfo,
    },
  };
};
