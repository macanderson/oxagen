// The signed-in person for the pre-workspace flows (invite, onboarding, the CLI
// and GitHub callbacks), which run before any organization scope exists and so
// cannot use `requireViewer`. It is lane L4's session seam (src/server/session.ts:
// Better Auth, or the dev-only fixture operator), narrowed to what these screens
// show.
import "server-only";
import { getSession } from "@/server/session";

export type AuthUser = { id: string; email: string; name: string };

export async function getAuthUser(): Promise<AuthUser | null> {
  const session = await getSession();
  if (!session) return null;
  const { id, email, name } = session.user;
  return { id, email, name: name ?? "" };
}
