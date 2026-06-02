import { apiKeyAuthMiddleware, type Middleware } from "xmcp";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEvent } from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { db } from "@oxagen/database/client";
import { extractBearerToken } from "./context";

// Wire the real IAM enforcement runtime at MCP surface startup.
// xmcp has no lifecycle hook — this module-level call runs once when the
// middleware bundle is loaded, before any tool invocation can occur.
// Idempotent: safe if the module is re-evaluated in dev hot-reload.
bootstrapIAMRuntime();

// Wire the Postgres security event emitter (SOC2 CC6/CC7 audit trail).
// Registered ONCE, immediately after bootstrapIAMRuntime(), so the db
// client is available before any tool invocation can emit a kernel event.
const _securityInsert = makeSecurityEventInserter(db());
setSecurityEventEmitter((kernelEvent) => {
  recordSecurityEvent(_securityInsert, {
    eventType:
      kernelEvent.outcome === "allow"
        ? "capability.invoke_allowed"
        : kernelEvent.outcome === "deny"
          ? "capability.invoke_denied"
          : "capability.invoke_error",
    actorUserId: kernelEvent.actorUserId,
    orgId: kernelEvent.orgId,
    workspaceId: kernelEvent.workspaceId,
    capability: kernelEvent.capability,
    outcome:
      kernelEvent.outcome === "allow"
        ? "allow"
        : kernelEvent.outcome === "deny"
          ? "deny"
          : "error",
    ip: null, // not available at kernel level — enrich at surface layer
    userAgent: null,
    requestId: kernelEvent.requestId,
  });
});

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
