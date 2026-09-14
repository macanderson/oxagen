import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";

// React `cache()` memoizes per-request; this collapses the Better Auth
// session lookup to a single DB hit across all RSCs in one request.
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export async function getSessionOrRedirect(redirectTo = "/login") {
  const session = await getSession();
  if (!session?.user) redirect(redirectTo);
  return session;
}
