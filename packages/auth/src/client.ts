import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { loadEnv } from "@oxagen/config/env";

// Explicit return-type cast to a structural shape silences TS's "inferred
// type cannot be named" diagnostic — better-auth's internal path-to-object
// types are not exported across package boundaries.
//
// On the browser, use `window.location.origin` so the client routes to the
// correct host without needing an explicit env var.
//
// On the server (SSR), pass the normalized BETTER_AUTH_URL from `loadEnv()`
// so that over-quoted env values (e.g. `"http://localhost:3000"` with literal
// surrounding quotes, common in Vercel dev setups) are stripped before being
// passed to better-auth. Passing `undefined` here causes better-auth to read
// `process.env.BETTER_AUTH_URL` directly — bypassing `normalizeEnv` — which
// produces an "Invalid URL" error on every SSR render.
export function resolveBaseURL(): string | undefined {
  // Use globalThis (not the bare `window` global) so this isomorphic module
  // typechecks in server packages whose tsconfig omits the DOM lib, while still
  // routing to the correct host in the browser.
  const browser = (
    globalThis as { window?: { location?: { origin?: string } } }
  ).window;
  if (browser?.location?.origin) return browser.location.origin;
  try {
    return loadEnv().BETTER_AUTH_URL;
  } catch {
    // loadEnv() may throw at build time when the full env is not present.
    // Fall through to undefined and let better-auth pick it up from the raw
    // process env, which is acceptable at build time.
    return undefined;
  }
}

/** Shape of a Better Auth client action result. */
type AuthResult<T> = Promise<{
  data?: T | null;
  error?: { message?: string } | null;
}>;

/**
 * The subset of the twoFactorClient plugin surface the app consumes, hand-typed
 * because the full inferred client type is not serializable across the package
 * boundary (see the annotation note below) — so `authClient` is capped to the
 * base `ReturnType<typeof createAuthClient>`, which drops plugin methods. We
 * re-attach this typed slice via an intersection so callers keep using
 * `authClient.twoFactor.*` with types intact.
 */
export interface TwoFactorClientActions {
  enable: (args: { password: string }) => AuthResult<{
    totpURI?: string;
    backupCodes?: string[];
  }>;
  verifyTotp: (args: {
    code: string;
    trustDevice?: boolean;
  }) => AuthResult<unknown>;
  verifyBackupCode: (args: {
    code: string;
    trustDevice?: boolean;
  }) => AuthResult<unknown>;
  disable: (args: { password: string }) => AuthResult<unknown>;
  generateBackupCodes: (args: { password: string }) => AuthResult<{
    backupCodes?: string[];
  }>;
}

// The explicit annotation caps the client to a nameable, serializable type:
// the fully-inferred type (especially with the twoFactor plugin's zod schemas)
// trips TS2883/TS7056 across the package boundary. We intersect the hand-typed
// twoFactor slice back on so plugin methods stay typed for consumers.
// `as unknown as` bypasses the structural friction of the huge inferred type.
export const authClient: ReturnType<typeof createAuthClient> & {
  twoFactor: TwoFactorClientActions;
} = createAuthClient({
  baseURL: resolveBaseURL(),
  // twoFactorClient exposes authClient.twoFactor.{enable,verifyTotp,disable,
  // generateBackupCodes,verifyBackupCode}. onTwoFactorRedirect fires when a
  // sign-in needs a second factor — route the user to the verification page.
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        const browser = (
          globalThis as { window?: { location?: { href: string } } }
        ).window;
        if (browser?.location) browser.location.href = "/two-factor";
      },
    }),
  ],
}) as unknown as ReturnType<typeof createAuthClient> & {
  twoFactor: TwoFactorClientActions;
};

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
