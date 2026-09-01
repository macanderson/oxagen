// instrumentation.ts — Next.js instrumentation hook (OXA-1502 / IAM bootstrap).
//
// Next.js calls `register()` once per server process on startup, before any
// request handler runs. This is the correct place to bootstrap the IAM
// enforcement runtime so kernel.invoke() in every server action, route
// handler, and RSC can run the full IAM check + ClickHouse audit write.
//
// Without this, the kernel falls open: capability calls proceed without IAM
// enforcement (no authz check, no audit event). See OXA-1390 for the full
// bootstrap specification.
//
// The Next.js instrumentation file must live at the root of the app
// (next to next.config.mjs), NOT under src/. The `experimental.instrumentationHook`
// flag is not required in Next.js 15+; the file is auto-discovered.
//
// IMPORTANT: Only import from packages that are safe to load at process start
// (before any DB schema migration has run). bootstrapIAMRuntime() gracefully
// degrades when Postgres tables don't yet exist — fetchAuthz() catches the
// pg 42P01 "relation does not exist" error and returns empty AuthzData,
// so all capabilities fall through to their defaultEffect.

/**
 * Next.js `onRequestError` hook — invoked for every uncaught server-side error
 * (route handlers, RSC, server actions). This is the official capture point for
 * apps/app's server runtime. Fire-and-forget via captureError(): records the
 * error to the ClickHouse error stream and (when ALERT_WEBHOOK_URL is set) fans
 * a Slack-compatible alert. Node runtime only — captureError pulls in the
 * ClickHouse client which is Node-only. See OXA observability audit item.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string },
  context: { routerKind?: string; routePath?: string; renderSource?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { captureError } = await import("@oxagen/telemetry");
    const where =
      context.routePath ?? request.path ?? context.renderSource ?? "app";
    captureError({
      error,
      source: "app",
      severity: "error",
      context: `app request error (${where})`,
    });
  } catch {
    // Never let error capture become a new failure source at the boundary.
  }
}

export async function register(): Promise<void> {
  // Guard: only run in the Node.js runtime (not in the Edge runtime or
  // during client-side builds). bootstrapIAMRuntime depends on @oxagen/database
  // which uses `pg` — a Node.js-only module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Bootstrap the OpenTelemetry SDK first so spans are captured from the
    // first request. No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset, so
    // this is safe in all envs. Rollback = leave the env var unset.
    const { initTracer } = await import("@oxagen/telemetry");
    initTracer();
    // Turbopack HMR re-evaluates module factories via (0, eval)(code) in global
    // scope where `require` is not defined (it's only a CJS module-wrapper param).
    // next/dist/esm/build/templates/app-page.js contains `require('path')` inside
    // its handler function; after any HMR update this throws ReferenceError.
    // Exposing require on globalThis makes it available to indirect-eval scope.
    // Only in Node.js dev — production never uses Turbopack HMR eval.
    // See: https://github.com/vercel/next.js issues with require in HMR eval context.
    if (process.env.NODE_ENV === "development") {
      // Make `require` available in global scope so that Turbopack HMR's indirect
      // eval — `(0, eval)(factoryCode)` — can resolve bare require() calls inside
      // re-evaluated module factories (e.g. `require('path')` in app-page.js).
      const { createRequire } = await import("module");
      (globalThis as unknown as Record<string, unknown>).require =
        createRequire(import.meta.url);
    }
    const { bootstrapIAMRuntime } = await import("@oxagen/iam");
    const { bootstrapBillingRuntime } = await import("@oxagen/billing");
    const { bootstrapEntitlementRuntime } = await import("@oxagen/plugins");
    const { bootstrapDecisionRulesRuntime } = await import("@oxagen/rules");
    const { setSecurityEventEmitter } = await import("@oxagen/oxagen/kernel");
    const { recordSecurityEvent } = await import("@oxagen/telemetry");
    const { makeSecurityEventInserter } = await import(
      "@oxagen/database/security"
    );
    const { assertRlsConnectionSafe } = await import("@oxagen/database");

    // Refuse to boot if a production runtime disabled RLS enforcement, or if
    // TENANT_RLS_ENFORCEMENT_ENABLED=true but the DB role silently bypasses RLS
    // (superuser or BYPASSRLS), which would make all tenant isolation policies
    // dead weight.
    await assertRlsConnectionSafe();

    bootstrapIAMRuntime();
    // Wire the billing admission gate (suspended / zero-balance refusal +
    // auto-reload) into kernel.invoke(), alongside the IAM gate.
    bootstrapBillingRuntime();
    // Wire the capability entitlement gate — blocks invocations of plugin-owned
    // capabilities when the plugin is not installed+enabled for the org.
    bootstrapEntitlementRuntime();
    // Wire the workspace decision-rules gate (refund ceilings, approval
    // thresholds, …) — governs which business actions an agent may take.
    bootstrapDecisionRulesRuntime();

    // Wire the Postgres security event emitter (SOC2 CC6/CC7 audit trail).
    // Registered once per server process, immediately after bootstrapIAMRuntime()
    // so the kernel runtime is initialised before any capability can be invoked.
    // makeSecurityEventInserter() now uses withSystemDb internally — no db() arg needed.
    const insert = makeSecurityEventInserter();
    setSecurityEventEmitter((kernelEvent) => {
      recordSecurityEvent(insert, {
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
}
