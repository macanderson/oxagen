import { redactUrlCredentials } from "@oxagen/config/public-url";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { CapabilityContext } from "../types";
import {
  mcpServerAuthKind,
  mcpServerHealthStatus,
  mcpServerTransportType,
  type AgentMcpListInput,
  type AgentMcpListOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.list";

export type { AgentMcpListInput, AgentMcpListOutput };

/**
 * A mcp_servers row holds a value the list contract does not admit. The DB
 * CHECK constraints and the NOT NULL jsonb default keep this from happening
 * on any write path, so reaching it means the row was written outside them.
 */
export class McpServerRowInvalidError extends Error {
  readonly code = "mcp_server_row_invalid";
  constructor(publicId: string, column: string, value: unknown) {
    super(
      `mcp_servers row ${publicId}: ${column} holds ${JSON.stringify(value)}`,
    );
    this.name = "McpServerRowInvalidError";
  }
}

function narrow<T extends [string, ...string[]]>(
  schema: z.ZodEnum<T>,
  publicId: string,
  column: string,
  value: unknown,
): T[number] {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new McpServerRowInvalidError(publicId, column, value);
  }
  return parsed.data;
}

type AuthRow = {
  publicId: string;
  authStrategy: string;
  listingAuthKind: string | null;
  iconUrl: string | null;
  credentialStatus: string | null;
  hasAccessToken: boolean | null;
  hasRefreshToken: boolean | null;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
};

/** The auth kind, icon and OAuth state one row reports. Exported for tests. */
export function authorizationOf(
  r: AuthRow,
): Pick<
  AgentMcpListOutput["servers"][number],
  "authKind" | "iconUrl" | "authorization"
> {
  const iconUrl = r.iconUrl?.startsWith("https://") ? r.iconUrl : null;
  if (r.listingAuthKind !== "oauth") {
    return {
      authKind: narrow(
        mcpServerAuthKind,
        r.publicId,
        "auth_strategy",
        r.authStrategy,
      ),
      iconUrl,
      authorization: null,
    };
  }
  const state =
    r.credentialStatus === "needs_reauth" || r.credentialStatus === "revoked"
      ? r.credentialStatus
      : r.hasAccessToken === true
        ? "connected"
        : "not_connected";
  return {
    authKind: "oauth",
    iconUrl,
    authorization: {
      state,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      refreshable: r.hasRefreshToken === true,
      lastRefreshedAt: r.lastRefreshedAt
        ? r.lastRefreshedAt.toISOString()
        : null,
    },
  };
}

export async function agentMcpListHandler(
  _input: AgentMcpListInput,
  ctx: CapabilityContext,
): Promise<AgentMcpListOutput> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        transportType: schema.mcpServers.transportType,
        endpointUrl: schema.mcpServers.endpointUrl,
        healthStatus: schema.mcpServers.healthStatus,
        lastHealthcheckAt: schema.mcpServers.lastHealthcheckAt,
        discoveredTools: schema.mcpServers.discoveredTools,
        authStrategy: schema.mcpServers.authStrategy,
        listingAuthKind: schema.pluginInstalledPlugins.authKind,
        iconUrl: schema.pluginInstalledPlugins.iconUrl,
        // Only whether a token is held and its lifetime; no secret column is
        // selected, so the list needs no KMS key and returns no material.
        credentialStatus: schema.mcpCredentials.status,
        hasAccessToken: sql<boolean>`${schema.mcpCredentials.accessTokenEnc} IS NOT NULL`,
        hasRefreshToken: sql<boolean>`${schema.mcpCredentials.refreshTokenEnc} IS NOT NULL`,
        expiresAt: schema.mcpCredentials.expiresAt,
        lastRefreshedAt: schema.mcpCredentials.lastRefreshedAt,
      })
      .from(schema.mcpServers)
      .leftJoin(
        schema.pluginInstalledPlugins,
        eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
      )
      .leftJoin(
        schema.mcpCredentials,
        and(
          eq(
            schema.mcpCredentials.orgListingId,
            schema.mcpServers.orgListingId,
          ),
          eq(schema.mcpCredentials.workspaceId, schema.mcpServers.workspaceId),
        ),
      )
      .where(
        and(
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, ctx.workspaceId),
          // Hide soft-deleted servers from the live list.
          isNull(schema.mcpServers.deletedAt),
        ),
      ),
  );
  return {
    servers: rows.map((r) => {
      if (!Array.isArray(r.discoveredTools)) {
        throw new McpServerRowInvalidError(
          r.publicId,
          "discovered_tools",
          r.discoveredTools,
        );
      }
      return {
        publicId: r.publicId,
        name: r.name,
        transportType: narrow(
          mcpServerTransportType,
          r.publicId,
          "transport_type",
          r.transportType,
        ),
        // The register guard refuses an address with userinfo, but a row
        // written before that guard can still hold one. The list is a read
        // surface, so it never returns the password or key in the clear.
        // agent.mcp.resolve still reads the raw column for the connection.
        endpointUrl: redactUrlCredentials(r.endpointUrl),
        healthStatus: narrow(
          mcpServerHealthStatus,
          r.publicId,
          "health_status",
          r.healthStatus,
        ),
        lastHealthcheckAt: r.lastHealthcheckAt
          ? r.lastHealthcheckAt.toISOString()
          : null,
        toolCount: r.discoveredTools.length,
        ...authorizationOf(r),
      };
    }),
  };
}
