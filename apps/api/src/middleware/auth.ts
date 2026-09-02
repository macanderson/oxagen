import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  parseSessionCookie,
  resolveSession,
  resolveApiKey,
} from "@oxagen/auth";
import type { ApiKeyResolutionError } from "@oxagen/auth";
import type { AppEnv } from "../app";

/**
 * Thin HTTP adapter — §7.3. Extracts the bearer token or session cookie
 * from the request and delegates all identity logic to the transport-agnostic
 * resolvers in @oxagen/auth. Sets userId / apiKeyId / orgId / workspaceId on
 * the Hono context; downstream org/workspace middleware reads those values.
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
      };
      const { kind } = result as ApiKeyResolutionError;
      throw new HTTPException(401, {
        message: messages[kind] ?? "Unauthorized",
      });
    }
    c.set("userId", null);
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
