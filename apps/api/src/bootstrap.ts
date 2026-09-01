// Side-effect imports: bind all foundation + agent capability handlers into
// the kernel before any route can call invoke(). Must run before bootstrap()
// logic; order is deterministic because both register modules are pure
// side-effect files that call registerHandler() synchronously.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

import { loadEnv } from "@oxagen/config/env";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { bootstrapBillingRuntime } from "@oxagen/billing";
import { bootstrapDecisionRulesRuntime } from "@oxagen/rules";
import { bootstrapEntitlementRuntime } from "@oxagen/plugins";
import { setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { initTracer, recordSecurityEvent } from "@oxagen/telemetry";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { assertRlsConnectionSafe } from "@oxagen/database";
import { isEmailVerificationRequired } from "@oxagen/auth";
import { isEmailTransportConfigured } from "@oxagen/notifications";
import { logger } from "./middleware/logger";

let bootPromise: Promise<void> | null = null;

/**
 * One-time process bootstrap shared by both entrypoints — the standalone Node
 * server (`src/index.ts`, local dev via tsx) and the Vercel serverless function
 * (`api/index.ts`).
 *
 * Memoized: the first caller kicks off the work and every concurrent or later
 * caller awaits the SAME promise (so the wiring runs exactly once per process).
 * On FAILURE the memo is cleared so a subsequent call retries — a transient
 * cold-start failure (e.g. the DB briefly unreachable during
 * assertRlsConnectionSafe) must not permanently wedge a serverless instance.
 * Callers MUST await the returned promise and handle rejection (the Vercel
 * entrypoint returns a 503; the standalone server fails fast on boot).
 */
export function bootstrap(): Promise<void> {
  if (!bootPromise) {
    bootPromise = runBootstrap().catch((err: unknown) => {
      // Clear the memo so the next call re-attempts rather than caching the
      // rejection forever; rethrow so this caller still sees the failure.
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

/**
 * The actual bootstrap work. Order matters:
 *  1. env validates first — any missing required key throws before a request is
 *     served (fail-closed per spec §11).
 *  2. assertRlsConnectionSafe — refuse to boot if a production runtime has RLS
 *     enforcement disabled, or if enforcement is on but the DB role silently
 *     bypasses RLS (superuser or BYPASSRLS).
 *  3. wire the IAM enforcement runtime into defineContract().invoke() before any
 *     route handler can call contract.invoke().
 *  4. register the Postgres security-event emitter (SOC2 CC6/CC7 audit trail);
 *     the kernel calls it fire-and-forget after every capability invocation.
 */
async function runBootstrap(): Promise<void> {
  loadEnv();

  // Bootstrap OpenTelemetry SDK first so spans are captured from the first
  // request. No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset (dev / rollback).
  initTracer();

  // OXA-1753: surface unconfigured SMTP loudly on deployed envs. Deployed envs
  // set Better Auth's requireEmailVerification=true, so every credential sign-up
  // needs the verification email to arrive — if SMTP_* is missing, sendEmail is
  // fire-and-forget and the failure is invisible to the user. We log here so
  // the misconfig shows up in deploy logs even if nothing probes /health, and
  // /health also reports it as 503 (see routes/health.ts). Non-throwing on
  // purpose — OAuth sign-in does not need SMTP and must keep working.
  if (isEmailVerificationRequired() && !isEmailTransportConfigured()) {
    logger.error(
      {
        check: "email_transport",
        ticket: "OXA-1753",
      },
      "email transport is unconfigured but requireEmailVerification=true — " +
        "every credential sign-up will silently fail to deliver the verification email. " +
        "Set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM_EMAIL.",
    );
  }

  // Refuse to boot if a production runtime disabled RLS enforcement, or if the
  // DB role silently bypasses RLS while enforcement is on.
  await assertRlsConnectionSafe();

  bootstrapIAMRuntime();
  // Wire the billing admission gate (suspended / zero-balance refusal +
  // auto-reload) into contract.invoke(), alongside the IAM gate.
  bootstrapBillingRuntime();
  // Workspace decision rules (refund ceilings, approval thresholds, …)
  // gate every scoped invoke after billing/entitlement. Dormant without this.
  bootstrapDecisionRulesRuntime();
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

// Internal: reset memoized boot state for testing. Not used in production.
export function __resetBootForTesting(): void {
  bootPromise = null;
}
