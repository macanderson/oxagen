"use server";
// The Add a provider wizard's registry search and OAuth (#4132).
//
// OAuth runs in a popup so the person never leaves the wizard:
//
//   1. `startProviderAuthorization` asks `start_mcp_authorization` for the
//      sign-in URL, and records the flow's state in a short-lived cookie
//      scoped to the callback path, beside the org and workspace it belongs
//      to. The wizard points its popup at the URL.
//   2. The provider sends the popup to `/api/v1/mcp/oauth/callback`, which
//      reads the cookie, matches the state, and calls
//      `completeProviderAuthorization` (`authorize_mcp_server`) as the viewer.
//   3. The callback page posts the outcome back to the wizard and closes.
//
// No token passes through here. The kernel stores it; this module sees a URL
// on the way out and a provider id on the way back.
import { cookies, headers } from "next/headers";
import { agentMcpAuthorizeComplete } from "@oxagen/oxagen/contracts/agent.mcp.authorize.complete";
import { agentMcpAuthorizeStart } from "@oxagen/oxagen/contracts/agent.mcp.authorize.start";
import { agentMcpRegistrySearch } from "@oxagen/oxagen/contracts/agent.mcp.registry.search";
import { RegistryPage } from "@/data/contracts/tools";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { getMetadataBase } from "@/shared/app-url";
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_COOKIE,
  pendingFlowsOf,
  type PendingFlow,
} from "./oauth-flow";

/** Registry results per page. */
const PAGE = 20;
/** How long a started sign-in may take, matching the kernel's PKCE state. */
const FLOW_SECONDS = 600;
/** Sign-ins held at once: one wizard and a reconnect or two. */
const MAX_FLOWS = 4;

/** One page of `search_mcp_registry`, checked against the view model. */
export async function searchRegistry(
  org: string,
  ws: string,
  input: { query: string; cursor?: string },
): Promise<ActionResult<RegistryPage>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: agentMcpRegistrySearch,
    input: {
      query: input.query.trim().slice(0, 120),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: PAGE,
    },
    page: "tools",
  });
  if (!read.ok) return readToActionResult<never>(read);
  const { servers, ...rest } = read.value;
  const parsed = RegistryPage.safeParse({
    ...rest,
    servers: servers.map(({ id, ...server }) => ({
      registryRef: id,
      ...server,
    })),
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: "unavailable", code: "record_unmappable" };
}

/**
 * The callback URL on the origin the person is using, so the popup lands where
 * the wizard can hear it. A host other than the app's own or a local one falls
 * back to the configured origin: a forwarded host is the client's to spell.
 */
async function callbackUrl(): Promise<string> {
  const base = getMetadataBase();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  let origin = base.origin;
  if (host !== null) {
    const hostname = host.split(":")[0] ?? "";
    const local = hostname === "localhost" || hostname === "127.0.0.1";
    if (local || host === base.host) {
      const proto = h.get("x-forwarded-proto") ?? (local ? "http" : "https");
      origin = `${proto}://${host}`;
    }
  }
  return new URL(MCP_OAUTH_CALLBACK_PATH, origin).toString();
}

/** What the wizard sends to start a sign-in. */
export type AuthorizationDraft = (
  | {
      mode: "add";
      name: string;
      endpointUrl: string;
      registryId?: string;
      iconUrl?: string;
      description?: string;
    }
  | { mode: "reconnect"; serverId: string }
) & {
  /** The workspace's own OAuth app. The secret is sent once and never returned. */
  client?: { clientId: string; clientSecret?: string; scopes?: string };
};

export type AuthorizationStart =
  | { status: "redirect"; authorizationUrl: string; state: string }
  | {
      status: "authorized";
      serverId: string;
      healthStatus: "healthy" | "degraded" | "unreachable";
      discoveredTools: readonly string[];
    }
  | {
      status: "client_required";
      scopesSupported: readonly string[];
      redirectUrl: string;
    }
  | { status: "not_oauth" };

function trimmedClient(
  client: AuthorizationDraft["client"],
): AuthorizationDraft["client"] {
  if (client === undefined) return undefined;
  const clientId = client.clientId.trim();
  if (clientId === "") return undefined;
  const secret = client.clientSecret?.trim() ?? "";
  const scopes = client.scopes?.trim() ?? "";
  return {
    clientId,
    ...(secret === "" ? {} : { clientSecret: secret }),
    ...(scopes === "" ? {} : { scopes }),
  };
}

export async function startProviderAuthorization(
  org: string,
  ws: string,
  draft: AuthorizationDraft,
): Promise<ActionResult<AuthorizationStart>> {
  if (draft.mode === "add") {
    const name = draft.name.trim();
    if (name === "" || name.length > 120) {
      return {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "name",
      };
    }
    if (draft.endpointUrl.trim() === "") {
      return {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "endpointUrl",
      };
    }
  }
  const ctx = await requireViewer(org, ws);
  const redirectUrl = await callbackUrl();
  const client = trimmedClient(draft.client);
  const result = await kernelWrite(ctx, agentMcpAuthorizeStart, {
    redirectUrl,
    ...(client === undefined ? {} : { client }),
    ...(draft.mode === "reconnect"
      ? { mcpServerId: draft.serverId }
      : {
          name: draft.name.trim(),
          endpointUrl: draft.endpointUrl.trim(),
          ...(draft.registryId === undefined
            ? {}
            : { registryId: draft.registryId }),
          ...(draft.iconUrl === undefined ? {} : { iconUrl: draft.iconUrl }),
          ...(draft.description === undefined
            ? {}
            : { description: draft.description.slice(0, 500) }),
        }),
  });
  if (!result.ok) return result;
  const out = result.value;
  switch (out.status) {
    case "redirect": {
      // Only an https authorization page is opened. An authorization server
      // that names anything else is refused here, not followed.
      let url: URL;
      try {
        url = new URL(out.authorizationUrl);
      } catch {
        return {
          ok: false,
          reason: "unavailable",
          code: "authorization_url_invalid",
        };
      }
      if (url.protocol !== "https:") {
        return {
          ok: false,
          reason: "unavailable",
          code: "authorization_url_invalid",
        };
      }
      const jar = await cookies();
      const flows: PendingFlow[] = [
        { org, ws, state: out.state },
        ...pendingFlowsOf(jar.get(MCP_OAUTH_COOKIE)?.value),
      ].slice(0, MAX_FLOWS);
      jar.set(MCP_OAUTH_COOKIE, JSON.stringify(flows), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: FLOW_SECONDS,
        path: MCP_OAUTH_CALLBACK_PATH,
      });
      return {
        ok: true,
        value: {
          status: "redirect",
          authorizationUrl: url.toString(),
          state: out.state,
        },
      };
    }
    case "authorized":
      return {
        ok: true,
        value: {
          status: "authorized",
          serverId: out.mcpServerId,
          healthStatus: out.healthStatus,
          discoveredTools: out.discoveredTools,
        },
      };
    case "client_required":
      return {
        ok: true,
        value: {
          status: "client_required",
          scopesSupported: out.scopesSupported,
          redirectUrl,
        },
      };
    case "not_oauth":
      return { ok: true, value: { status: "not_oauth" } };
  }
}

/** The redirect URL a workspace registers its own OAuth app with. */
export async function providerRedirectUrl(
  org: string,
  ws: string,
): Promise<ActionResult<{ redirectUrl: string }>> {
  await requireViewer(org, ws);
  return { ok: true, value: { redirectUrl: await callbackUrl() } };
}

/** The callback's half: exchange the code as the viewer who started the flow. */
export async function completeProviderAuthorization(
  org: string,
  ws: string,
  input: { state: string; code: string },
): Promise<
  ActionResult<{
    serverId: string;
    name: string;
    healthStatus: "healthy" | "degraded" | "unreachable";
    discoveredTools: readonly string[];
  }>
> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentMcpAuthorizeComplete, {
    state: input.state,
    code: input.code,
    redirectUrl: await callbackUrl(),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          serverId: result.value.mcpServerId,
          name: result.value.name,
          healthStatus: result.value.healthStatus,
          discoveredTools: result.value.discoveredTools,
        },
      }
    : result;
}
