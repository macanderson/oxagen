import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  parseSessionCookie,
  resolveSession,
  resolveApiKey,
} from "@oxagen/auth";
import type { ApiKeyResolutionError } from "@oxagen/auth";
import type { AppEnv } from "../app";

/** The 403 body for a key its organization's Require SSO policy refuses. */
export const API_KEY_SSO_REQUIRED_MESSAGE =
  "This organization requires single sign-on. The person who created this key must sign in through SSO.";

/**
 * Thin HTTP adapter — §7.3. Extracts the bearer token or session cookie
 * from the request and delegates all identity logic to the transport-agnostic
 * resolvers in @oxagen/auth. Sets userId / apiKeyId / orgId / workspaceId on
 * the Hono context; downstream org/workspace middleware reads those values.
 * A bearer key's `userId` is the resolver's: the approving user for a CLI
 * session key, null for every other key.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const rawKey = authHeader.slice("Bearer ".length).trim();
    const result = await resolveApiKey(rawKey);
    if (!result.ok) {
      const messages: Record<string, string> = {
        malformed: "Malformed API key",
        invalid: "Invalid API key",
        expired: "API key expired",
        purpose_locked:
          "API key is locked to a purpose this surface does not serve",
        workspace_archived:
          "This API key's workspace is archived; restore the workspace or use a key in an active one",
      };
      const { kind } = result as ApiKeyResolutionError;
      // Require SSO (ADR-145) refuses a genuine key on policy grounds, so it
      // answers 403 rather than 401: the credential is recognized, and the
      // organization will not accept it until its creator signs in through SSO.
      if (kind === "sso_required") {
        throw new HTTPException(403, { message: API_KEY_SSO_REQUIRED_MESSAGE });
      }
      throw new HTTPException(401, {
        message: messages[kind] ?? "Unauthorized",
      });
    }
    c.set("userId", result.userId);
    c.set("apiKeyId", result.apiKeyId);
    // API keys pre-bind scope; downstream org/workspace middleware skips
    // slug resolution when these are already set.
    c.set("orgId", result.orgId);
    c.set("workspaceId", result.workspaceId);
    return next();
  }

  // Better Auth session cookie path.
  const cookieToken = parseSessionCookie(c.req.header("cookie"));
  if (!cookieToken)
    throw new HTTPException(401, { message: "Missing credentials" });

  const session = await resolveSession(cookieToken);
  if (!session) throw new HTTPException(401, { message: "Session expired" });

  c.set("userId", session.userId);
  c.set("apiKeyId", null);
  return next();
};
