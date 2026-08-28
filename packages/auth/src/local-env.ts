/**
 * local-env.ts — single source of truth for "is this a developer machine / the
 * E2E harness, as opposed to a deployed (production/preview) environment?"
 *
 * This predicate gates security relaxations in auth.ts — no email verification,
 * no mandatory OAuth-token-encryption key, relaxed cookies/rate-limits. Getting
 * it wrong in either direction is bad: false-in-local 403s every credential
 * sign-in (you can't use the app); true-in-prod disables real security controls.
 *
 * Why not just `NODE_ENV === "development"`? Because NODE_ENV is unreliable at
 * module-load time on a local box:
 *   - `next dev` sets process.env.NODE_ENV='development', but the auth module can
 *     be evaluated during an early boot window before that assignment lands, so
 *     the betterAuth config (built ONCE at import) can snapshot
 *     NODE_ENV='production' → requireEmailVerification=true → every local
 *     sign-in fails until an unrelated recompile re-evaluates the module.
 *   - tsx-run services (apps/api, apps/mcp) don't set NODE_ENV at all.
 *
 * The fix mirrors the existing E2E_TEST escape hatch: an explicit, deterministic
 * flag — OXAGEN_LOCAL_DEV — set for the whole local stack by tools/scripts/dev.ts.
 * It is honored ONLY when not on a real Vercel deployment (process.env.VERCEL is
 * always "1" there), so it can never weaken production even if it leaked into a
 * deployed env file.
 */

export interface LocalEnvSignals {
  /** Normalized NODE_ENV (already quote-stripped by @oxagen/config). */
  nodeEnv: string | undefined;
  /** process.env.VERCEL — "1" on any Vercel deployment, unset locally. */
  vercel: string | undefined;
  /** process.env.VERCEL_ENV — "development" | "preview" | "production". */
  vercelEnv: string | undefined;
  /** process.env.E2E_TEST — "true" under the Playwright harness. */
  e2eTest: string | undefined;
  /** process.env.OXAGEN_LOCAL_DEV — "1"/"true", set by tools/scripts/dev.ts. */
  localDevFlag: string | undefined;
}

export function resolveIsLocalEnv(signals: LocalEnvSignals): boolean {
  const isVercelDeploy = Boolean(signals.vercel);
  const localDevFlag =
    signals.localDevFlag === "1" || signals.localDevFlag === "true";

  return (
    // Deterministic local signal — but never trust it on a real deployment.
    (!isVercelDeploy && localDevFlag) ||
    signals.nodeEnv === "development" ||
    signals.nodeEnv === "test" ||
    signals.vercelEnv === "development" ||
    // E2E_TEST is a developer/CI-harness signal, never a deployment one. Guard it
    // with !isVercelDeploy exactly like localDevFlag so a leaked E2E_TEST=true in
    // a real Vercel env can't relax production auth (email verification, OAuth
    // token-encryption guard, secure cookies, rate limiting).
    (!isVercelDeploy && signals.e2eTest === "true")
  );
}

/**
 * Whether the current environment requires verified-email-before-sign-in
 * (Better Auth's `requireEmailVerification`). True on deployed Vercel envs,
 * false on local/CI. Mirrors the exact predicate that gates the auth config
 * in `auth.ts` — keep them in lockstep so callers (e.g. the API `/health`
 * gate) evaluate the same condition the runtime auth actually enforces.
 *
 * Defaults to reading `process.env`; pass an explicit env object for tests.
 */
export function isEmailVerificationRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !resolveIsLocalEnv({
    nodeEnv: env.NODE_ENV,
    vercel: env.VERCEL,
    vercelEnv: env.VERCEL_ENV,
    e2eTest: env.E2E_TEST,
    localDevFlag: env.OXAGEN_LOCAL_DEV,
  });
}
