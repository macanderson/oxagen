import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { resolveScimToken } from "@oxagen/auth/scim-token";
import { scimRequest } from "@oxagen/oxagen/contracts/scim.request";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../lib/context";
import { logger } from "../middleware/logger";
import type { AppEnv } from "../app";

/**
 * SCIM 2.0 (RFC 7644) for one organization, mounted at `/api/scim/v2` (#3734).
 * The app proxies `https://app.oxagen.sh/api/scim/v2/*` here, which is the
 * base URL the Single sign-on page gives an identity provider.
 *
 * The bearer token is the boundary. It is minted on Organization › Single
 * sign-on, resolves to exactly one organization, and no request can name
 * another: there is no organization in the path, the query or the body. This
 * route authenticates the token and hands every request to
 * `execute_scim_request` through `invoke()`, so the kernel's IAM check and its
 * audit row apply to every SCIM write, and the handler re-checks the token.
 *
 * Every answer is `application/scim+json`, errors included, because identity
 * providers show the SCIM error `detail` to the admin who configured them.
 */
export const SCIM_MOUNT = "/api/scim/v2";

/** Okta and Entra ID send one resource per request; 1 MiB is generous. */
const MAX_BODY_BYTES = 1024 * 1024;

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type ScimMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function scimJson(c: Context<AppEnv>, status: number, body: unknown) {
  c.header("Content-Type", "application/scim+json");
  if (body === null) return c.body(null, status as StatusCode);
  return c.body(JSON.stringify(body), status as ContentfulStatusCode);
}

function scimError(
  c: Context<AppEnv>,
  status: number,
  detail: string,
  scimType?: string,
) {
  return scimJson(c, status, {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

export const scimRoute = new Hono<AppEnv>();

scimRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      scimError(c as Context<AppEnv>, 413, "The request body is too large"),
  }),
);

scimRoute.all("*", async (c) => {
  const method = c.req.method.toUpperCase();
  if (!METHODS.has(method)) {
    return scimError(c, 405, `${method} is not supported`);
  }

  const header = c.req.header("authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const resolution = raw ? await resolveScimToken(raw) : null;
  if (!resolution?.ok) {
    // An unknown token names no organization, so there is nobody's audit
    // trail to write it to; the request log keeps it.
    logger.warn(
      { reason: resolution?.kind ?? "missing", path: c.req.path },
      "scim: bearer token refused",
    );
    c.header("WWW-Authenticate", 'Bearer realm="oxagen-scim"');
    return scimError(c, 401, "A valid SCIM bearer token is required");
  }

  let body: unknown;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    try {
      body = await c.req.json();
    } catch {
      return scimError(
        c,
        400,
        "The request body is not valid JSON",
        "invalidSyntax",
      );
    }
  }

  // The token names the organization. No user and no API key: the identity
  // provider is neither, and execute_scim_request refuses a call carrying one.
  c.set("orgId", resolution.orgId);
  c.set("workspaceId", null);
  c.set("userId", null);
  c.set("apiKeyId", null);
  const ctx = capabilityContext(c, { requireWorkspace: false });

  const mountAt = c.req.path.indexOf(SCIM_MOUNT);
  const path =
    mountAt >= 0
      ? c.req.path.slice(mountAt + SCIM_MOUNT.length) || "/"
      : c.req.path;
  try {
    // No `surface`: execute_scim_request declares none, and this route is its
    // only caller (see the contract).
    const result = (await invoke(
      scimRequest.name,
      {
        tokenId: resolution.tokenId,
        method: method as ScimMethod,
        path,
        query: c.req.query(),
        ...(body !== undefined ? { body } : {}),
      },
      ctx,
    )) as { status: number; body: unknown; location?: string };
    if (result.location) c.header("Location", result.location);
    return scimJson(
      c,
      result.status,
      result.status === 204 ? null : result.body,
    );
  } catch (err) {
    const code =
      typeof err === "object" && err !== null
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "invalid_input") {
      return scimError(
        c,
        400,
        "The request is not a valid SCIM request",
        "invalidSyntax",
      );
    }
    if (code === "authz_denied" || code === "forbidden") {
      return scimError(
        c,
        403,
        "This organization's policy refuses the request",
      );
    }
    logger.error(
      { err, orgId: resolution.orgId, method, path },
      "scim: request failed",
    );
    return scimError(c, 500, "The request could not be completed");
  }
});
