// Side-effect imports: bind all foundation + agent capability handlers into
// the kernel. These run at module-load time — before bootstrapIAMRuntime()
// and before any tool invocation can occur. xmcp has no lifecycle hook, so
// module scope is the only guaranteed-run location on cold start.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

import { apiKeyAuthMiddleware, type Middleware } from "xmcp";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { bootstrapBillingRuntime } from "@oxagen/billing";
import { bootstrapEntitlementRuntime } from "@oxagen/plugins";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import {
  initTracer,
  recordSecurityEvent,
  captureError,
} from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { assertRlsConnectionSafe } from "@oxagen/database";
import { extractBearerToken } from "./context";

// Refuse to boot if a production runtime disabled RLS enforcement, or if
// TENANT_RLS_ENFORCEMENT_ENABLED=true but the DB role silently bypasses RLS
// (superuser or BYPASSRLS), which would make all tenant isolation policies
// dead weight.
await assertRlsConnectionSafe();

// Bootstrap OpenTelemetry SDK. No-op when OTEL_EXPORTER_OTLP_ENDPOINT is
// unset — all spans degrade to no-ops without any perf overhead.
initTracer();

// Wire the real IAM enforcement runtime at MCP surface startup.
// xmcp has no lifecycle hook — this module-level call runs once when the
// middleware bundle is loaded, before any tool invocation can occur.
// Idempotent: safe if the module is re-evaluated in dev hot-reload.
bootstrapIAMRuntime();
// Wire the billing admission gate (suspended / zero-balance refusal +
// auto-reload) into kernel.invoke(), alongside the IAM gate.
bootstrapBillingRuntime();
// Wire the capability entitlement gate — blocks invocations of plugin-owned
// capabilities when the plugin is not installed+enabled for the org.
bootstrapEntitlementRuntime();

// Wire the Postgres security event emitter (SOC2 CC6/CC7 audit trail).
// Registered ONCE, immediately after bootstrapIAMRuntime(), so the db
// client is available before any tool invocation can emit a kernel event.
const _securityInsert = makeSecurityEventInserter();
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

  // xmcp exposes no request-level error hook (its only middleware is the
  // pre-request auth gate), so the kernel's error outcome is the MCP surface's
  // capture point for the runtime error stream. Only "error" outcomes are
  // captured here (deny is an authz decision, not a fault); the kernel event
  // carries no raw error object, so we synthesize a message from the failing
  // capability + error code. Full-detail capture for API/app/inngest happens at
  // their own boundaries (Hono onError, Next onRequestError, inngest failure fn).
  if (kernelEvent.outcome === "error") {
    captureError({
      error: new Error(
        `mcp capability error: ${kernelEvent.capability} (${kernelEvent.errorCode ?? "unknown"})`,
      ),
      source: "mcp",
      severity: "error",
      orgId: kernelEvent.orgId || null,
      workspaceId: kernelEvent.workspaceId || null,
      capability: kernelEvent.capability,
      requestId: kernelEvent.requestId || null,
    });
  }
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
