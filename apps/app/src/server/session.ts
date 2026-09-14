// The signed-in person for this request: Better Auth through @oxagen/auth.
//
// Better Auth is imported lazily so a module that only needs the types never
// evaluates @oxagen/auth/server, which reads its env at import.
import "server-only";
import { headers } from "next/headers";
import { cache } from "react";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

export type AppSession = { user: SessionUser };

/** Uncached read; use `getSession` in request code. Exported for tests. */
export async function readSession(): Promise<AppSession | null> {
  const { auth } = await import("@oxagen/auth/server");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const { id, email, name, image } = session.user;
  return { user: { id, email, name: name || null, image: image ?? null } };
}

/** The request's session, memoized per request: one Better Auth lookup however many components ask. */
export const getSession = cache(readSession);
