// OAuth authorization for an MCP server, driven from the Add a provider wizard
// (#4132). Two halves, one capability each:
//
//   start     `start_mcp_authorization`: find or create the provider's
//             listing, store the OAuth app the workspace brought (if any), and
//             run the SDK's `auth()` to its redirect. The wizard opens the
//             returned URL in a popup.
//   complete  `authorize_mcp_server`: the app's callback hands the
//             code back; exchange it, store the tokens, list the server's
//             tools and upsert the provider row.
//
// Storage is the one the runtime already reads (plugin-types/mcp.ts): a
// `plugin.installed_plugins` listing with `auth_kind = 'oauth'`, the client
// and tokens envelope-encrypted in `mcp.credentials`, and an `mcp.mcp_servers`
// row linked to the listing. So a provider added here refreshes its token
// through `DbOAuthClientProvider`, is flipped to `needs_reauth` on a 401, and
// is renewed by the refresh watcher, with no second path to keep in step.
//
// No token ever leaves this module: `start` returns a URL, `complete` returns
// the provider's id and tool names.
import { randomBytes } from "node:crypto";
import {
  auth,
  discoverOAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  assertPublicHttpUrl,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  DbOAuthClientProvider,
  deleteOAuthState,
  detectOAuthProtected,
  getWorkspaceSecret,
  loadOAuthState,
  preregisteredClientForEndpoint,
  setWorkspaceSecret,
} from "@oxagen/plugins";
import type {
  AgentMcpAuthorizeStartInput,
  AgentMcpAuthorizeStartOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.authorize.start";
import type { AgentMcpAuthorizeCompleteOutput } from "@oxagen/oxagen/contracts/agent.mcp.authorize.complete";
import { healthcheck } from "../dispatch/mcp-client";
import { captureToolSnapshots, recordServerChange } from "./mcp-snapshots";
import { mcpOAuthFetch } from "./mcp-oauth-fetch";

/** The path every redirect URL must end in: the app's one callback route. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/v1/mcp/oauth/callback";

const CLIENT_NAME = "Oxagen";

export type FlowScope = {
  orgId: string;
  workspaceId: string;
  userId: string | null | undefined;
};

type Listing = {
  id: string;
  title: string;
  endpointUrl: string;
};

function refuse(
  code: "forbidden" | "not_found" | "conflict",
  reason: string,
  message: string,
): never {
  throw new HandlerError({ code, reason, message });
}

/**
 * The redirect URL must be an http(s) URL ending in the callback path. The
 * origin is the app's own, which only the app knows, so it is checked for
 * shape here and bound to the flow: the exchange uses the URL `start` stored.
 */
export function assertRedirectUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(
      "conflict",
      "redirect_url_invalid",
      "The redirect URL is not a URL",
    );
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.pathname !== MCP_OAUTH_CALLBACK_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return refuse(
      "conflict",
      "redirect_url_invalid",
      `The redirect URL must be <app origin>${MCP_OAUTH_CALLBACK_PATH}`,
    );
  }
  return url.toString();
}

function assertEndpoint(raw: string): string {
  try {
    return assertPublicHttpUrl(raw, {
      refusing: "Refusing to authorize an MCP server",
      requireTls: true,
    }).toString();
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      return refuse("conflict", "endpoint_not_public", err.message);
    }
    throw err;
  }
}

/** The listing key: the registry id, or the endpoint for a custom server. */
export function listingKeyOf(
  registryId: string | undefined,
  endpointUrl: string,
): string {
  if (registryId !== undefined && registryId.trim() !== "")
    return registryId.trim();
  const url = new URL(endpointUrl);
  return `custom:${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function providerFor(
  scope: FlowScope,
  listing: Listing,
  redirectUrl: string,
  state: string,
): DbOAuthClientProvider {
  return new DbOAuthClientProvider({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    orgListingId: listing.id,
    redirectUrl,
    state,
    returnTo: "",
    clientName: CLIENT_NAME,
    now: () => Date.now(),
    serverUrl: listing.endpointUrl,
  });
}

async function listingForServer(
  scope: FlowScope,
  mcpServerId: string,
): Promise<Listing> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.pluginInstalledPlugins.id,
        title: schema.mcpServers.name,
        endpointUrl: schema.mcpServers.endpointUrl,
        authKind: schema.pluginInstalledPlugins.authKind,
      })
      .from(schema.mcpServers)
      .innerJoin(
        schema.pluginInstalledPlugins,
        eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
      )
      .where(
        and(
          eq(schema.mcpServers.publicId, mcpServerId),
          eq(schema.mcpServers.orgId, scope.orgId),
          eq(schema.mcpServers.workspaceId, scope.workspaceId),
          isNull(schema.mcpServers.deletedAt),
        ),
      )
      .limit(1),
  );
  if (row === undefined) {
    return refuse(
      "not_found",
      "server_not_found",
      "No provider in this workspace uses OAuth under that id",
    );
  }
  return { id: row.id, title: row.title, endpointUrl: row.endpointUrl };
}

async function upsertListing(
  scope: FlowScope,
  input: {
    key: string;
    title: string;
    endpointUrl: string;
    description: string | null;
    iconUrl: string | null;
    source: "registry" | "custom";
  },
): Promise<Listing> {
  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.pluginInstalledPlugins)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        pluginType: "mcp_server",
        source: input.source,
        name: input.key,
        title: input.title,
        description: input.description,
        iconUrl: input.iconUrl,
        endpointUrl: input.endpointUrl,
        transport: "streamable-http",
        authKind: "oauth",
        enabled: true,
        createdById: scope.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [
          schema.pluginInstalledPlugins.orgId,
          schema.pluginInstalledPlugins.workspaceId,
          schema.pluginInstalledPlugins.pluginType,
          schema.pluginInstalledPlugins.name,
        ],
        set: {
          title: input.title,
          description: input.description,
          iconUrl: input.iconUrl,
          endpointUrl: input.endpointUrl,
          transport: "streamable-http",
          authKind: "oauth",
          enabled: true,
          deletedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.pluginInstalledPlugins.id }),
  );
  if (row === undefined) throw new Error("installed_plugins upsert failed");
  return { id: row.id, title: input.title, endpointUrl: input.endpointUrl };
}

/**
 * Whether a client exists for this listing without dynamic registration: one
 * the workspace stored, or a platform pre-registered one for the host.
 */
async function hasClient(scope: FlowScope, listing: Listing): Promise<boolean> {
  const stored = await getWorkspaceSecret({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    orgListingId: listing.id,
  });
  if (stored?.oauthClientId) return true;
  return preregisteredClientForEndpoint(listing.endpointUrl) !== undefined;
}

type StartDeps = {
  fetchFn?: typeof fetch;
  newState?: () => string;
};

export async function startMcpAuthorization(
  scope: FlowScope,
  input: AgentMcpAuthorizeStartInput,
  deps: StartDeps = {},
): Promise<AgentMcpAuthorizeStartOutput> {
  const fetchFn = deps.fetchFn ?? mcpOAuthFetch;
  const redirectUrl = assertRedirectUrl(input.redirectUrl);

  let listing: Listing;
  if (input.mcpServerId !== undefined) {
    listing = await listingForServer(scope, input.mcpServerId);
  } else {
    if (input.name === undefined || input.endpointUrl === undefined) {
      return refuse(
        "conflict",
        "provider_unnamed",
        "Name a provider to reconnect, or a name and an endpoint to add",
      );
    }
    const endpointUrl = assertEndpoint(input.endpointUrl);
    // A server that asks for no OAuth is added with a static credential or
    // none, and the wizard says so rather than storing an OAuth listing that
    // will never authorize.
    if (!(await detectOAuthProtected(endpointUrl, { fetchFn }))) {
      return { status: "not_oauth" };
    }
    listing = await upsertListing(scope, {
      key: listingKeyOf(input.registryId, endpointUrl),
      title: input.name,
      endpointUrl,
      description: input.description ?? null,
      iconUrl:
        input.iconUrl !== undefined && input.iconUrl.startsWith("https://")
          ? input.iconUrl
          : null,
      source: input.registryId === undefined ? "custom" : "registry",
    });
  }

  if (input.client !== undefined) {
    // The workspace's own OAuth app replaces any client stored before, which
    // is how a person fixes a wrong id or secret.
    await setWorkspaceSecret({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      orgListingId: listing.id,
      authKind: "oauth",
      oauthClientId: input.client.clientId,
      oauthClientSecret: input.client.clientSecret ?? null,
      ...(input.client.scopes
        ? { scopes: input.client.scopes.split(/\s+/).filter(Boolean) }
        : {}),
    });
  }

  let scopesSupported: string[] = [];
  if (input.client === undefined && !(await hasClient(scope, listing))) {
    // No client to present: the server has to register one. Read its
    // metadata first so a server that cannot is answered with the form for
    // the workspace's own OAuth app, not an SDK error.
    try {
      const info = await discoverOAuthServerInfo(listing.endpointUrl, {
        fetchFn,
      });
      scopesSupported = info.resourceMetadata?.scopes_supported ?? [];
      const meta = info.authorizationServerMetadata;
      if (meta !== undefined && !meta.registration_endpoint) {
        return { status: "client_required", scopesSupported };
      }
    } catch {
      return refuse(
        "conflict",
        "authorization_discovery_failed",
        "The server's OAuth metadata could not be read",
      );
    }
  }

  const state = (
    deps.newState ?? (() => randomBytes(24).toString("base64url"))
  )();
  const provider = providerFor(scope, listing, redirectUrl, state);
  let result: "AUTHORIZED" | "REDIRECT";
  try {
    result = await auth(provider, {
      serverUrl: listing.endpointUrl,
      ...(input.client?.scopes ? { scope: input.client.scopes } : {}),
      fetchFn,
    });
  } catch (err) {
    const message = String(err);
    if (message.includes("does not support dynamic client registration")) {
      return { status: "client_required", scopesSupported };
    }
    return refuse(
      "conflict",
      "authorization_failed",
      "The authorization server refused to start sign-in",
    );
  }

  if (result === "AUTHORIZED") {
    // A stored refresh token was still good: nothing to sign in to.
    const done = await recordAuthorizedServer(scope, listing, redirectUrl);
    return {
      status: "authorized",
      mcpServerId: done.mcpServerId,
      healthStatus: done.healthStatus,
      discoveredTools: done.discoveredTools,
    };
  }
  if (provider.pendingRedirect === null) {
    return refuse(
      "conflict",
      "authorization_failed",
      "The authorization server returned no sign-in URL",
    );
  }
  return {
    status: "redirect",
    authorizationUrl: provider.pendingRedirect.toString(),
    state,
  };
}

export async function completeMcpAuthorization(
  scope: FlowScope,
  input: { state: string; code: string; redirectUrl: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<AgentMcpAuthorizeCompleteOutput> {
  const fetchFn = deps.fetchFn ?? mcpOAuthFetch;
  const redirectUrl = assertRedirectUrl(input.redirectUrl);
  const saved = await loadOAuthState(input.state, Date.now());
  // A state from another workspace is answered like an expired one: the
  // caller learns nothing about flows outside its own tenant.
  if (
    saved === null ||
    saved.orgId !== scope.orgId ||
    saved.workspaceId !== scope.workspaceId
  ) {
    return refuse(
      "not_found",
      "authorization_expired",
      "This sign-in expired or belongs to another workspace; start it again",
    );
  }
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.pluginInstalledPlugins.id,
        title: schema.pluginInstalledPlugins.title,
        name: schema.pluginInstalledPlugins.name,
        endpointUrl: schema.pluginInstalledPlugins.endpointUrl,
      })
      .from(schema.pluginInstalledPlugins)
      .where(
        and(
          eq(schema.pluginInstalledPlugins.id, saved.orgListingId),
          eq(schema.pluginInstalledPlugins.orgId, scope.orgId),
          isNull(schema.pluginInstalledPlugins.deletedAt),
        ),
      )
      .limit(1),
  );
  if (row?.endpointUrl === undefined || row.endpointUrl === null) {
    await deleteOAuthState(input.state).catch(() => undefined);
    return refuse("not_found", "server_not_found", "The provider was removed");
  }
  const listing: Listing = {
    id: row.id,
    title: row.title ?? row.name,
    endpointUrl: row.endpointUrl,
  };
  const provider = providerFor(scope, listing, redirectUrl, input.state);
  try {
    await auth(provider, {
      serverUrl: listing.endpointUrl,
      authorizationCode: input.code,
      fetchFn,
    });
  } catch {
    return refuse(
      "conflict",
      "authorization_failed",
      "The authorization server refused the sign-in code",
    );
  } finally {
    // The PKCE verifier is single use whichever way the exchange went.
    await deleteOAuthState(input.state).catch(() => undefined);
  }
  return recordAuthorizedServer(scope, listing, redirectUrl);
}

/**
 * The provider row for an authorized listing: probe it with the stored token,
 * upsert `mcp.mcp_servers` (reviving a removed one), pin its tool descriptors
 * and record the enable.
 */
async function recordAuthorizedServer(
  scope: FlowScope,
  listing: Listing,
  redirectUrl: string,
): Promise<AgentMcpAuthorizeCompleteOutput> {
  const probe = await healthcheck({
    endpointUrl: listing.endpointUrl,
    authStrategy: "none",
    authProvider: providerFor(
      scope,
      listing,
      redirectUrl,
      `runtime:${listing.id}`,
    ),
  });
  const now = new Date();
  const [server] = await withTenantDb((tx) =>
    tx
      .insert(schema.mcpServers)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        orgListingId: listing.id,
        name: listing.title,
        transportType: "streamable-http",
        endpointUrl: listing.endpointUrl,
        // The runtime takes the OAuth branch from the listing's auth kind;
        // `bearer` is the strategy the OAuth callback has always written.
        authStrategy: "bearer",
        authConfig: {},
        healthStatus: probe.status,
        lastHealthcheckAt: now,
        discoveredTools: probe.discoveredTools as object,
        enabled: true,
        createdById: scope.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.mcpServers.workspaceId, schema.mcpServers.orgListingId],
        // The unique index is partial; the inference clause carries its predicate.
        targetWhere: sql`org_listing_id IS NOT NULL`,
        set: {
          name: listing.title,
          endpointUrl: listing.endpointUrl,
          healthStatus: probe.status,
          lastHealthcheckAt: now,
          discoveredTools: probe.discoveredTools as object,
          enabled: true,
          deletedAt: null,
          deletedById: null,
          updatedAt: now,
          updatedById: scope.userId ?? null,
        },
      })
      .returning({
        id: schema.mcpServers.id,
        publicId: schema.mcpServers.publicId,
      }),
  );
  if (server === undefined) throw new Error("mcp_servers upsert failed");
  if (probe.descriptors.length > 0) {
    await captureToolSnapshots({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      mcpServerId: server.id,
      descriptors: probe.descriptors,
      ...(scope.userId ? { createdById: scope.userId } : {}),
    }).catch(() => {
      /* the provider is authorized; the runtime pins on first use */
    });
  }
  await recordServerChange({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    serverId: server.id,
    changeType: "enable",
    actorUserId: scope.userId ?? null,
  });
  return {
    mcpServerId: server.publicId,
    name: listing.title,
    healthStatus: probe.status,
    discoveredTools: probe.discoveredTools,
  };
}
