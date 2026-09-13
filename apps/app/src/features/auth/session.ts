// The signed-in person for the pre-workspace flows (invite, onboarding, the CLI
// and GitHub callbacks), which run before any organization scope exists and so
// cannot use `requireViewer`.
//
// Fixture mode reads only the fixture session cookie; a Better Auth cookie is
// ignored there. Otherwise Better Auth resolves the session from the request
// headers. `@oxagen/auth/server` is imported lazily: it validates its env at
// module load, which a fixture dev server does not carry.
//
// Promote: the live half is lane L4's src/server/session.ts; replace this with
// it once L4 merges, keeping the fixture branch's negative test.
import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import {
  FIXTURE_SESSION_COOKIE,
  isFixtureMode,
  readFixtureSession,
} from "@/server/fixture-session";

export type AuthUser = { id: string; email: string; name: string };

export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  if (isFixtureMode()) {
    const store = await cookies();
    const session = readFixtureSession(
      store.get(FIXTURE_SESSION_COOKIE)?.value,
    );
    return session ? { ...session.user } : null;
  }
  const { auth } = await import("@oxagen/auth/server");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
});
