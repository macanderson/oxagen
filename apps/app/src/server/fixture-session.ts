// A dev-only signed-in session for the fixture data source (MC_DATA=fixture).
//
// e2e, Storybook and local development render pages against the fixture seed
// without Postgres or Better Auth. They sign in by setting one cookie. That
// cookie is honoured only when BOTH hold:
//   - the build is not a production build (`process.env.NODE_ENV` is inlined
//     as "production" by `next build`, so the check below is constant-folded and
//     the fixture branch is removed from production bundles), and
//   - MC_DATA is "fixture" at runtime.
// `requireViewer` (src/server/scope.ts, lane L4) and `src/proxy.ts` consult it.
//
// Edge-safe: no Node built-ins, so `proxy.ts` can import it.

export const FIXTURE_SESSION_COOKIE = "mc_fixture_session";

/** The cookie value that signs in the fixture operator. Any other value is ignored. */
export const FIXTURE_SESSION_VALUE = "marcus-bell";

/** The fixture seed's operator (plan §2.1: Acme Robotics / core-platform / Marcus Bell). */
export const FIXTURE_USER = {
  id: "usr_marcusbell",
  email: "marcus.bell@acme.example",
  name: "Marcus Bell",
} as const;

export type FixtureSession = { user: typeof FIXTURE_USER };

export function isFixtureMode(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.MC_DATA === "fixture";
}

/** The fixture session for a cookie value, or null outside fixture mode or for any other value. */
export function readFixtureSession(
  cookieValue: string | undefined,
): FixtureSession | null {
  if (!isFixtureMode()) return null;
  if (cookieValue !== FIXTURE_SESSION_VALUE) return null;
  return { user: FIXTURE_USER };
}
