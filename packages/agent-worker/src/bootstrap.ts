// Side-effect imports: bind all foundation + agent capability handlers into
// the kernel before the worker can drive a turn (the platform turn driver
// materializes capability tools and re-enters invoke() for every tool call —
// with no handlers registered, every capability resolves to `no_handler`).
// Must run before bootstrap() logic; order is deterministic because both
// register modules are pure side-effect files calling registerHandler()
// synchronously. Mirrors apps/api/src/bootstrap.ts.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

import { loadEnv } from "@oxagen/config/env";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { bootstrapBillingRuntime } from "@oxagen/billing";
import { bootstrapEntitlementRuntime } from "@oxagen/plugins";
import { bootstrapEngramRuntime } from "@oxagen/agent";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { initTracer, recordSecurityEvent } from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { assertRlsConnectionSafe } from "@oxagen/database";
import { createEventClient } from "@oxagen/inngest-functions/adapter";

let bootPromise: Promise<void> | null = null;

/**
 * One-time process bootstrap for the durable-run worker — the same wiring
 * apps/api's bootstrap performs, because the worker hosts the SAME kernel:
 * the turn driver's capability tools re-enter invoke(), and invoke() without
 * this wiring runs with no registered handlers and, worse, with the IAM /
 * billing-admission / entitlement gates un-injected. The sovereignty rule
 * (docs/specs/agent-engine-v2/spec.md §4: "the engine is the brain, the
 * kernel remains the law") only holds in a process that wires the law in.
 *
 * Deliberately NOT mirrored from the API bootstrap: the SMTP/email-transport
 * check (an auth-surface concern — the worker serves no sign-ups).
 *
 * Memoized with retry-on-failure, same as the API: a transient boot failure
 * (DB briefly unreachable during assertRlsConnectionSafe) must not wedge the
 * process permanently if a supervisor retries.
 */
export function bootstrap(): Promise<void> {
  if (!bootPromise) {
    bootPromise = runBootstrap().catch((err: unknown) => {
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

async function runBootstrap(): Promise<void> {
  // Env validates first — a missing required key throws before any run is
  // claimed (fail-closed).
  loadEnv();

  // OTel before anything else so the first claimed run is traced. No-op when
  // OTEL_EXPORTER_OTLP_ENDPOINT is unset.
  initTracer();

  // Refuse to boot if RLS enforcement is off in production, or if the DB role
  // silently bypasses RLS while enforcement is on. The worker writes through
  // withSystemDb by design (cross-org claims), but tenant-scoped paths (tool
  // handlers) still rely on RLS being real.
  await assertRlsConnectionSafe();

  // The kernel's blocking gates: IAM, billing admission, entitlements. These
  // are injected process-globals — without them invoke() cannot enforce.
  bootstrapIAMRuntime();
  bootstrapBillingRuntime();
  bootstrapEntitlementRuntime();

  // Engram async backends (graph-sync/embed fan-out + compile telemetry).
  // Best-effort — degraded Inngest/ClickHouse never breaks a run; without
  // this the driver's memory writes would be silently dropped.
  bootstrapEngramRuntime(createEventClient());

  // SOC2 audit trail: the kernel emits a security event after every
  // capability invocation, fire-and-forget. Same mapping as the API surface;
  // ip/userAgent are surface-level fields the worker does not have.
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
      ip: null,
      userAgent: null,
      requestId: kernelEvent.requestId,
    });
  });
}
