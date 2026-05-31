import { apiKeyAuthMiddleware, type Middleware } from "xmcp";
import { extractBearerToken } from "./context.js";

/**
 * MCP transport-layer auth gate.
 *
 * Fast-fails any request that does not carry a well-formed
 * `Authorization: Bearer <token>` credential, before a tool is ever
 * dispatched. The authoritative resolution — API key / session token → tenant
 * scope, plus the fail-closed reject on invalid/expired — happens in
 * buildContext() at the capability boundary (src/context.ts). Keeping the
 * single DB-backed resolution there avoids a duplicate lookup per request
 * while this gate cheaply turns away obviously-unauthenticated callers.
 *
 * SECURITY: identity is derived solely from this validated credential — never
 * from client-controlled identity headers (`x-oxagen-org-id` & friends).
 */
export default apiKeyAuthMiddleware({
  headerName: "authorization",
  validateApiKey: async (authHeader) => {
    if (typeof authHeader !== "string") return false;
    return extractBearerToken(authHeader) !== null;
  },
}) satisfies Middleware;
