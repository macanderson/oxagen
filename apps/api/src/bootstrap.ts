// Side-effect imports: bind all foundation + agent capability handlers into
// the kernel before any route can call invoke(). Must run before bootstrap()
// logic; order is deterministic because both register modules are pure
// side-effect files that call registerHandler() synchronously.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

import { loadEnv } from "@oxagen/config/env";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { bootstrapBillingRuntime } from "@oxagen/billing";
import { bootstrapEntitlementRuntime } from "@oxagen/plugins";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEvent } from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { assertRlsConnectionSafe } from "@oxagen/database";

let booted = false;

/**
 * One-time process bootstrap shared by both entrypoints — the standalone Node
 * server (`src/index.ts`, local dev via tsx) and the Vercel serverless function
 * (`api/index.ts`). Idempotent: safe to call on every cold start / hot reload.
 *
 * Order matters:
 *  1. env validates first — any missing required key throws before a request is
 *     served (fail-closed per spec §11).
 *  2. assertRlsConnectionSafe — refuse to boot if TENANT_RLS_ENFORCEMENT_ENABLED=true
 *     but the DB role silently bypasses RLS (superuser or BYPASSRLS).
 *  3. wire the IAM enforcement runtime into defineContract().invoke() before any
 *     route handler can call contract.invoke().
 *  4. register the Postgres security-event emitter (SOC2 CC6/CC7 audit trail);
 *     the kernel calls it fire-and-forget after every capability invocation.
 */
export async function bootstrap(): Promise<void> {
  if (booted) return;
  booted = true;

  loadEnv();

  // Refuse to boot if the DB role silently bypasses RLS while enforcement is on.
  await assertRlsConnectionSafe();

  bootstrapIAMRuntime();
  // Wire the billing admission gate (suspended / zero-balance refusal +
  // auto-reload) into contract.invoke(), alongside the IAM gate.
  bootstrapBillingRuntime();
  // Wire the capability entitlement gate — blocks invocations of plugin-owned
  // capabilities when the plugin is not installed+enabled for the org.
  bootstrapEntitlementRuntime();

  // makeSecurityEventInserter() now uses withSystemDb internally — no db() arg.
  const securityInsert = makeSecurityEventInserter();
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

// Internal: reset booted state for testing. Not exported in production.
export function __resetBootForTesting(): void {
  booted = false;
}
