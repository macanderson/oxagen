import { createAuthClient } from "better-auth/react";

// Explicit return-type cast to a structural shape silences TS's "inferred
// type cannot be named" diagnostic — better-auth's internal path-to-object
// types are not exported across package boundaries.
export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
