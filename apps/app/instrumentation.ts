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

export async function register(): Promise<void> {
  // Guard: only run in the Node.js runtime (not in the Edge runtime or
  // during client-side builds). bootstrapIAMRuntime depends on @oxagen/database
  // which uses `pg` — a Node.js-only module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapIAMRuntime } = await import("@oxagen/iam");
    bootstrapIAMRuntime();
  }
}
