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
// (see `pnpm release:<patch|minor|major>`), and the release script propagates
// that value to Vercel as the `PLATFORM_VERSION` env var across every
// environment. At runtime, prefer the injected env tag; fall back to "0.0.0"
// when unset (local processes that never loaded it) so callers always get a
// string. Surface it in UIs/telemetry instead of hardcoding a version anywhere.
//
// PLATFORM_VERSION is deliberately absent from baseEnvSchema (it is a release
// tag, not a service secret), so it cannot go through normalizeEnv(). We reuse
// stripOneQuotePair() to handle values pasted into the Vercel dashboard with
// surrounding quotes — same rule, one place.
export function platformVersion(): string {
  const raw = process.env.PLATFORM_VERSION;
  if (!raw) return "0.0.0";
  return stripOneQuotePair(raw);
}
