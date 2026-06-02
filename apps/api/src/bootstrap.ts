import { loadEnv } from "@oxagen/config/env";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEvent } from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { db } from "@oxagen/database/client";

let booted = false;

/**
 * One-time process bootstrap shared by both entrypoints — the standalone Node
 * server (`src/index.ts`, local dev via tsx) and the Vercel serverless function
 * (`api/index.ts`). Idempotent: safe to call on every cold start / hot reload.
 *
 * Order matters:
 *  1. env validates first — any missing required key throws before a request is
 *     served (fail-closed per spec §11).
 *  2. wire the IAM enforcement runtime into defineContract().invoke() before any
 *     route handler can call contract.invoke().
 *  3. register the Postgres security-event emitter (SOC2 CC6/CC7 audit trail);
 *     the kernel calls it fire-and-forget after every capability invocation.
 */
export function bootstrap(): void {
  if (booted) return;
  booted = true;

  loadEnv();
  bootstrapIAMRuntime();

  const securityInsert = makeSecurityEventInserter(db());
  setSecurityEventEmitter((kernelEvent) => {
    recordSecurityEvent(securityInsert, {
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
}
