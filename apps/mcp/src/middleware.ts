import { apiKeyAuthMiddleware, type Middleware } from "xmcp";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { extractBearerToken } from "./context.js";

// Wire the real IAM enforcement runtime at MCP surface startup.
// xmcp has no lifecycle hook — this module-level call runs once when the
// middleware bundle is loaded, before any tool invocation can occur.
// Idempotent: safe if the module is re-evaluated in dev hot-reload.
bootstrapIAMRuntime();

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
