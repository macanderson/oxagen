// The signed-in person for this request: Better Auth through @oxagen/auth, or
// the dev-only fixture operator when the app runs on the fixture data source.
//
// Better Auth is imported lazily so fixture mode (no Postgres, no auth secrets)
// never evaluates @oxagen/auth/server, which reads its env at import. The
// fixture branch is guarded by isFixtureMode(), which is constant-false in a
// production build; session.test.ts proves a production request carrying the
// fixture cookie still goes to Better Auth.
import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import {
  FIXTURE_SESSION_COOKIE,
  isFixtureMode,
  readFixtureSession,
} from "./fixture-session";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

export type AppSession = {
  user: SessionUser;
  /** Where the session came from. `fixture` never occurs in a production build. */
  source: "better-auth" | "fixture";
};

/** Uncached read; use `getSession` in request code. Exported for tests. */
export async function readSession(): Promise<AppSession | null> {
  if (isFixtureMode()) {
    const jar = await cookies();
    const fixture = readFixtureSession(jar.get(FIXTURE_SESSION_COOKIE)?.value);
    if (!fixture) return null;
    return {
      source: "fixture",
      user: {
        id: fixture.user.id,
        email: fixture.user.email,
        name: fixture.user.name,
        image: null,
      },
    };
  }
  const { auth } = await import("@oxagen/auth/server");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const { id, email, name, image } = session.user;
  return {
    source: "better-auth",
    user: { id, email, name: name || null, image: image ?? null },
  };
}

/** The request's session, memoized per request: one Better Auth lookup however many components ask. */
export const getSession = cache(readSession);
