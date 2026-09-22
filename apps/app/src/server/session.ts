// The session seam (ARCHITECTURE.md §3.7): the signed-in person for this
// request, and the Better Auth server calls the sign-in flows make. It is the
// only server module under src/ that imports @oxagen/auth; the browser half is
// src/features/auth/auth-client.ts. A destination Better Auth sends a person
// to is a SafePath.
//
// Better Auth is imported lazily so a module that only needs the types never
// evaluates @oxagen/auth/server, which reads its env at import.
import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import type { SafePath } from "@/shared/safe-path";

type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  /** Set by the twoFactor plugin (packages/auth/src/auth.ts); absent means not enrolled. */
  twoFactorEnabled: boolean;
};

export type AppSession = {
  user: SessionUser;
  /**
   * How this session was established (auth.sessions.auth_method, written by
   * packages/auth): "sso:<providerId>" for an SSO sign-in, otherwise
   * "password", "social:<provider>" or "other". Null or absent on a session
   * older than the column; the require-SSO gate reads that as not SSO.
   */
  authMethod?: string | null;
};

/** Uncached read; request code uses `getSession`. */
async function readSession(): Promise<AppSession | null> {
  const { auth } = await import("@oxagen/auth/server");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const { id, email, name, image, emailVerified } = session.user;
  // The twoFactor plugin adds the column; the base session type does not name it.
  const enrolled: unknown = Reflect.get(session.user, "twoFactorEnabled");
  // A session additionalField (packages/auth/src/auth.ts); the capped server
  // type does not name it either.
  const method: unknown = Reflect.get(session.session, "authMethod");
  return {
    authMethod: typeof method === "string" ? method : null,
    user: {
      id,
      email,
      name: name || null,
      image: image ?? null,
      emailVerified,
      twoFactorEnabled: enrolled === true,
    },
  };
}

/** The request's session, memoized per request: one Better Auth lookup however many components ask. */
export const getSession = cache(readSession);

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  /** Better Auth maps `image` to `auth.users.avatar_url` (packages/auth/src/auth.ts). */
  avatarUrl: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
};

/** The signed-in person as the sign-in flows and the shell show them; null when signed out. */
export async function getAuthUser(): Promise<AuthUser | null> {
  const session = await getSession();
  if (!session) return null;
  const { id, email, name, image, emailVerified, twoFactorEnabled } =
    session.user;
  return {
    id,
    email,
    name: name ?? "",
    avatarUrl: image,
    emailVerified,
    twoFactorEnabled,
  };
}

/** The Better Auth API route, with failed sign-ins audited (packages/auth/src/auth-route.ts). */
export async function handleAuthRequest(request: Request): Promise<Response> {
  const { handleAuthRequest: handle } = await import("@oxagen/auth/route");
  return handle(request);
}

/** Emails a reset link; Better Auth appends `?token=` to `redirectTo` and checks it against its trusted origins. */
export async function requestPasswordReset(input: {
  email: string;
  redirectTo: SafePath;
}): Promise<void> {
  const { auth } = await import("@oxagen/auth/server");
  await auth.api.requestPasswordReset({ body: input });
}

export async function resetPassword(input: {
  token: string;
  newPassword: string;
}): Promise<void> {
  const { auth } = await import("@oxagen/auth/server");
  await auth.api.resetPassword({ body: input });
}

/** Emails a verification link that lands on `callbackURL` once verified. */
export async function sendVerificationEmail(input: {
  email: string;
  callbackURL: SafePath;
}): Promise<void> {
  const { auth } = await import("@oxagen/auth/server");
  await auth.api.sendVerificationEmail({ body: input });
}
