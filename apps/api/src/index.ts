import { serve } from "@hono/node-server";
import { loadEnv } from "@oxagen/config/env";
import { PORTS } from "@oxagen/config";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEvent } from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { db } from "@oxagen/database/client";
import { app } from "./app";
import { logger } from "./middleware/logger";

// Boot wrapper: env validates first; any missing required key crashes the
// process before Hono starts listening. Fail-closed per spec §11.
loadEnv();

// Wire the real IAM enforcement runtime into defineContract().invoke().
// Must run before any route handler can call contract.invoke() — here at the
// top-level of the process entry point that guarantees this ordering.
// Idempotent: safe to call again in test hot-reload scenarios.
bootstrapIAMRuntime();

// Wire the Postgres security event emitter (SOC2 CC6/CC7 audit trail).
// The kernel calls this fire-and-forget after every capability invocation
// (allow / deny / error). Registered ONCE after bootstrapIAMRuntime() so the
// db client is available and the kernel runtime is already initialised.
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

const port = PORTS.api;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
