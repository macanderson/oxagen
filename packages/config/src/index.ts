export * from "./env";
export * from "./registry";
export * from "./domain";
export * from "./geo";

import { stripOneQuotePair } from "./env";

export const PORTS = {
  app: 3000,
  website: 3100,
  api: 4000,
  mcp: 4100,
} as const;

// Lockstep platform version. Every workspace package is released at one version
// (see `pnpm release:<patch|minor|major>`). At runtime, prefer the injected env
// tag; fall back to "0.0.0" when unset so callers always get a string. Surface
// it in UIs/telemetry instead of hardcoding a version anywhere.
//
// Nothing injects it in production today. The release script used to write the
// tag into every Vercel project's environment; that propagation went with the
// Vercel deploy configuration, and the AWS deploy does not yet put the var in
// SSM `/oxagen/production`. So the fallback is what production reports — treat
// a "0.0.0" in telemetry as "unset", not as a genuine pre-1.0 build.
//
// PLATFORM_VERSION is deliberately absent from baseEnvSchema (it is a release
// tag, not a service secret), so it cannot go through normalizeEnv(). We reuse
// stripOneQuotePair() to handle values that arrive with surrounding quotes —
// same rule, one place.
export function platformVersion(): string {
  const raw = process.env.PLATFORM_VERSION;
  if (!raw) return "0.0.0";
  return stripOneQuotePair(raw);
}
