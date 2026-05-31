import { createAuthClient } from "better-auth/react";
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
function resolveBaseURL(): string | undefined {
  if (typeof window !== "undefined") return window.location.origin;
  try {
    return loadEnv().BETTER_AUTH_URL;
  } catch {
    // loadEnv() may throw at build time when the full env is not present.
    // Fall through to undefined and let better-auth pick it up from the raw
    // process env, which is acceptable at build time.
    return undefined;
  }
}

export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: resolveBaseURL(),
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
