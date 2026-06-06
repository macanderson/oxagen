export * from "./env";
export * from "./registry";
export * from "./domain";
export * from "./geo";

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
export function platformVersion(): string {
  const raw = process.env.PLATFORM_VERSION;
  if (!raw) return "0.0.0";
  // Values pasted into a Vercel dashboard arrive double-quoted; strip one pair.
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

