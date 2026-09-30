import {
  priceAtPerThousand,
  readWeeklyContextPrice,
  STANDING_CONTEXT_WEEK_DAYS,
  type WeeklyContextPrice,
} from "@oxagen/billing";
import { redactUrlCredentials } from "@oxagen/config/public-url";
import { withTenantDb, schema } from "@oxagen/database";
import { selectToolProviderTokens } from "@oxagen/telemetry";
import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";
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

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.mcp" },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Each tool provider's newest listed tokens over the last week, keyed by the
 * name the harness calls it (#4537).
 */
async function providerTokens(now: Date): Promise<Map<string, number>> {
  const rows = await selectToolProviderTokens({
    fromMs: now.getTime() - STANDING_CONTEXT_WEEK_DAYS * DAY_MS,
    toMs: now.getTime(),
  });
  return new Map(rows.map((row) => [row.provider, row.tokens]));
}

/**
 * A read the roster can go without. A failed telemetry or price book read
 * leaves the figures null and the servers listed, and the log says which
 * read failed.
 */
async function orNull<T>(read: Promise<T>, what: string): Promise<T | null> {
  try {
    return await read;
  } catch (err: unknown) {
    logger.warn({ err }, `agent.mcp.list: ${what} read failed`);
    return null;
  }
}

type ServerView = AgentMcpListOutput["servers"][number];

/**
 * What a server's tokens cost the workspace over the week: the tokens at the
 * week's price per 1,000, an estimate. Null without either figure.
 */
function weeklyPriceOf(
  tokens: number | null,
  price: WeeklyContextPrice | null,
): ServerView["weeklyPrice"] {
  if (tokens === null || price === null) return null;
  return {
    micros: priceAtPerThousand(price.perThousandMicros, tokens).toString(),
    currency: price.currency,
    basis: "estimated",
  };
}

/**
 * The roster with each server's standing context tokens and their weekly
 * price (#4537). The recorder names a tool part's provider after the
 * harness's `mcp__<server>__<tool>`, and Oxagen writes that server key as the
 * row's `name` (`beltDenyPatterns` in @oxagen/handlers compiles `name:tool`
 * to the same form), so a server's tokens are the provider of its name.
 *
 * The price is `readWeeklyContextPrice`: each of the workspace's model calls
 * of the week, priced at the book's cache read rate in force when it ran, or
 * its input rate when the call read nothing from the cache. The server
 * multiplies it by the tokens, so the app renders a figure and multiplies
 * nothing (ADR-060).
 */
export async function agentMcpListHandler(
  _input: AgentMcpListInput,
  ctx: CapabilityContext,
): Promise<AgentMcpListOutput> {
  const now = new Date();
  const [rows, tokens, price] = await Promise.all([
    selectServerRows(ctx),
    orNull(providerTokens(now), "tool provider tokens"),
    orNull<WeeklyContextPrice | null>(
      readWeeklyContextPrice(
        { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        now,
      ),
      "weekly context price",
    ),
  ]);
  return {
    servers: rows.map((r) => {
      const contextTokens = tokens?.get(r.name) ?? null;
      return {
        ...serverView(r),
        contextTokens,
        weeklyPrice: weeklyPriceOf(contextTokens, price),
      };
    }),
  };
}

function selectServerRows(ctx: CapabilityContext) {
  return withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        transportType: schema.mcpServers.transportType,
        endpointUrl: schema.mcpServers.endpointUrl,
        healthStatus: schema.mcpServers.healthStatus,
        lastHealthcheckAt: schema.mcpServers.lastHealthcheckAt,
        discoveredTools: schema.mcpServers.discoveredTools,
        origin: schema.mcpServers.origin,
        steeringName: schema.mcpServers.steeringName,
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
}

type ServerRow = Awaited<ReturnType<typeof selectServerRows>>[number];

function serverView(
  r: ServerRow,
): Omit<ServerView, "contextTokens" | "weeklyPrice"> {
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
    steeringName: steeringNameOf(r),
  };
}

/**
 * The folder a steering repo gives the server, or null for a server added
 * any other way. A steering row always names one, and a row from before the
 * column was written reads as null.
 */
function steeringNameOf(
  r: Pick<ServerRow, "origin" | "steeringName">,
): string | null {
  return r.origin === "steering" && r.steeringName ? r.steeringName : null;
}
