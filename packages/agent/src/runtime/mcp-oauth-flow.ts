// OAuth authorization for an MCP server, driven from the Add a provider wizard
// (#4132). Two halves, one capability each:
//
//   start     `start_mcp_authorization`: find or create the provider's
//             listing, store the OAuth app the workspace brought (if any), and
//             run the SDK's `auth()` to its redirect. The wizard opens the
//             returned URL in a popup.
//   complete  `authorize_mcp_server`: the app's callback hands the
//             code back; exchange it, store the tokens, list the server's
//             tools and upsert the provider row. Once the workspace's tools
//             live in its steering repo, the row is proposed in a steering
//             PR instead (`recordAuthorizedServer`).
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
  getWorkspaceSecret,
  loadOAuthState,
  preregisteredClientForEndpoint,
  resolveEndpointRedirects,
  setWorkspaceSecret,
} from "@oxagen/plugins";
import type {
  AgentMcpAuthorizeStartInput,
  AgentMcpAuthorizeStartOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.authorize.start";
import type { AgentMcpAuthorizeCompleteOutput } from "@oxagen/oxagen/contracts/agent.mcp.authorize.complete";
import { healthcheck, type McpToolDescriptor } from "../dispatch/mcp-client";
import { captureToolSnapshots, recordServerChange } from "./mcp-snapshots";
import { probeMcpAuth } from "./mcp-auth-probe";
import { mcpOAuthFetch } from "./mcp-oauth-fetch";
import { steeringWriter } from "./steering-pr";
import { proposeListingServer } from "./steering-proposal";

/** The path every redirect URL must end in: the app's one callback route. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/v1/mcp/oauth/callback";

/** Where the app serves Oxagen's OAuth client metadata document. */
export const MCP_OAUTH_CLIENT_METADATA_PATH =
  "/api/v1/mcp/oauth/client-metadata";

/**
 * Oxagen's client ID at a server that accepts a Client ID Metadata Document:
 * the document's URL on the callback's own origin, since the document lists
 * that origin's callback. Only an https origin can be one, so a local http
 * callback gets none and the flow registers as before.
 */
export function clientMetadataUrlFor(redirectUrl: string): string | undefined {
  const url = new URL(redirectUrl);
  return url.protocol === "https:"
    ? new URL(MCP_OAUTH_CLIENT_METADATA_PATH, url.origin).toString()
    : undefined;
}

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
 * shape here. The exchange sends the URL `complete` is given, and the
 * authorization server refuses it unless it is the one `start` sent.
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
  const clientMetadataUrl = clientMetadataUrlFor(redirectUrl);
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
    ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
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
  // A static-auth provider has no sign-in to renew: tokens stored against its
  // listing would never be read, since the runtime takes the OAuth branch
  // only for an `oauth` listing.
  if (row === undefined || row.authKind !== "oauth") {
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

/** The client stored for a listing, and the callback it was registered with. */
async function storedClient(
  scope: FlowScope,
  listing: Listing,
): Promise<{ redirectUri: string | null } | null> {
  const stored = await getWorkspaceSecret({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    orgListingId: listing.id,
  });
  return stored?.oauthClientId
    ? { redirectUri: stored.oauthClientRedirectUri ?? null }
    : null;
}

/**
 * Forgets a listing's client and the tokens issued to it, so sign-in can
 * obtain a client that is bound to the current callback.
 */
async function forgetClient(scope: FlowScope, listing: Listing): Promise<void> {
  await setWorkspaceSecret({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    orgListingId: listing.id,
    authKind: "oauth",
    oauthClientId: null,
    oauthClientSecret: null,
    oauthClientAuthMethod: null,
    oauthClientRedirectUri: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
  });
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
    // A registry record can name a vanity URL that redirects to the real MCP
    // endpoint. Discovery and the SDK's resource check run against the URL
    // stored here, so it is the one the redirects end at, checked again.
    const endpointUrl = assertEndpoint(
      await resolveEndpointRedirects(assertEndpoint(input.endpointUrl), {
        fetchFn,
      }),
    );
    // A server that says it needs no credential is added open, and the
    // wizard says so rather than storing an OAuth listing that will never
    // authorize. A server that did not answer the probe is not taken for
    // open: sign-in is tried, and its discovery says what went wrong.
    if ((await probeMcpAuth(endpointUrl, fetchFn)) === "none") {
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
      // The method a registered client held does not carry over to this one.
      oauthClientAuthMethod: null,
      // The person registered their app with the callback the form showed.
      oauthClientRedirectUri: redirectUrl,
      ...(input.client.scopes
        ? { scopes: input.client.scopes.split(/\s+/).filter(Boolean) }
        : {}),
    });
  }

  // Which client sign-in presents: see "Client identity" in the capability
  // doc. Discovery runs when there is no usable client, to answer a server
  // that cannot give one with the form for the workspace's own OAuth app
  // rather than an SDK error.
  let scopesSupported: string[] = [];
  let metadataFound = true;
  if (input.client === undefined) {
    const stored = await storedClient(scope, listing);
    const platform =
      preregisteredClientForEndpoint(listing.endpointUrl) !== undefined;
    // A client registered for another callback (the app moved origin, or it
    // was stored before the callback was recorded) cannot complete sign-in.
    const stale = stored !== null && stored.redirectUri !== redirectUrl;
    if ((stored === null && !platform) || stale) {
      let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
      try {
        info = await discoverOAuthServerInfo(listing.endpointUrl, { fetchFn });
      } catch {
        return refuse(
          "conflict",
          "authorization_discovery_failed",
          "The server's OAuth metadata could not be read",
        );
      }
      scopesSupported = info.resourceMetadata?.scopes_supported ?? [];
      const meta = info.authorizationServerMetadata;
      metadataFound =
        meta !== undefined || info.resourceMetadata !== undefined;
      // A server that takes Oxagen's client metadata document needs no
      // registration endpoint: the document's URL is the client ID.
      const takesMetadataDocument =
        meta?.client_id_metadata_document_supported === true &&
        clientMetadataUrlFor(redirectUrl) !== undefined;
      const issuesClient =
        platform || Boolean(meta?.registration_endpoint) || takesMetadataDocument;
      if (stored === null) {
        if (meta !== undefined && !issuesClient) {
          return { status: "client_required", scopesSupported };
        }
      } else if (issuesClient) {
        await forgetClient(scope, listing);
      } else if (stored.redirectUri !== null) {
        // The workspace's own app was registered with another callback, and
        // the server issues no client itself: the app needs the new one.
        return { status: "client_required", scopesSupported };
      }
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
    // Still no client after the attempt: the server refused the registration
    // itself. Vercel does this for any redirect URL it has not approved. The
    // person is told that, not that sign-in failed, since signing in again
    // cannot help and their own OAuth app might.
    if (!metadataFound) {
      return refuse(
        "conflict",
        "authorization_discovery_failed",
        "The server publishes no OAuth metadata to sign in with",
      );
    }
    if ((await provider.clientInformation()) === undefined) {
      return refuse(
        "conflict",
        "registration_refused",
        "The authorization server refused to register Oxagen as an OAuth client",
      );
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
      ...(done.steeringPr === undefined ? {} : { steeringPr: done.steeringPr }),
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
 * Pin the tool descriptors a probe listed. A failure is swallowed: the
 * provider is authorized, and the runtime pins on first use.
 */
async function pinDescriptors(
  scope: FlowScope,
  mcpServerId: string,
  descriptors: readonly McpToolDescriptor[],
): Promise<void> {
  if (descriptors.length === 0) return;
  await captureToolSnapshots({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    mcpServerId,
    descriptors: [...descriptors],
    ...(scope.userId ? { createdById: scope.userId } : {}),
  }).catch(() => undefined);
}

/**
 * The provider row for an authorized listing: probe it with the stored token,
 * upsert `mcp.mcp_servers` (reviving a removed one), pin its tool descriptors
 * and record the enable.
 *
 * In a workspace whose tools live in its steering repo (`steeringWriter`,
 * ADR-209 §6), the tokens are stored all the same, but the row is decided the
 * way `set_plugin_enabled` decides it (`proposeListingServer`). A server the
 * repo already holds is written as above. A server with an open steering PR
 * is left off, and the sign-in answers `steering_pr_open`. Any other server
 * becomes a proposed, disabled row, its tools are pinned, and a steering PR
 * adds its folder. No enable is recorded for either, because nothing was
 * turned on.
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
  // The tokens are stored either way. A check that could not reach the server
  // right after sign-in is recorded as not yet known, since the runtime leaves
  // an unreachable provider out of every turn.
  const storedHealth = probe.status === "unreachable" ? "unknown" : probe.status;

  const writer = await steeringWriter({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
  });
  if (writer !== null) {
    const outcome = await proposeListingServer(writer, {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId: scope.userId ?? null,
      listing: { id: listing.id, name: listing.title },
      values: {
        name: listing.title,
        transportType: "streamable-http",
        endpointUrl: listing.endpointUrl,
        authStrategy: "bearer",
        healthStatus: storedHealth,
        lastHealthcheckAt: now,
        discoveredTools: probe.discoveredTools as object,
        createdById: scope.userId ?? null,
      },
      refresh: {
        name: listing.title,
        endpointUrl: listing.endpointUrl,
        healthStatus: storedHealth,
        lastHealthcheckAt: now,
        discoveredTools: probe.discoveredTools as object,
      },
      // Pinned before the PR opens, so the folder it adds lists these tools.
      beforeOpen: (serverId) =>
        pinDescriptors(scope, serverId, probe.descriptors),
      caller: "authorize_mcp_server",
    });
    if (outcome.kind === "pending") {
      return refuse(
        "conflict",
        "steering_pr_open",
        `Your sign-in to ${listing.title} is saved. The server turns on when the steering PR that adds tools/servers/${outcome.folder}/ merges and publishes.`,
      );
    }
    if (outcome.kind === "proposed") {
      return {
        mcpServerId: outcome.publicId,
        name: listing.title,
        healthStatus: probe.status,
        discoveredTools: probe.discoveredTools,
        steeringPr: { number: outcome.pr.number, url: outcome.pr.url },
      };
    }
  }

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
        healthStatus: storedHealth,
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
          healthStatus: storedHealth,
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
  await pinDescriptors(scope, server.id, probe.descriptors);
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
