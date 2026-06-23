import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { withSystemDb, schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { ProfileForm } from "./profile-form";
import { fetchConnectedAccountsState } from "./security-action";
import { userPreferencesReadHandler } from "@oxagen/handlers/user.preferences.read";
import type { CapabilityContext } from "@oxagen/oxagen";

export default async function AccountProfilePage() {
  const session = await getSessionOrRedirect();

  // Fetch profile data, linked accounts, and preferences in parallel.
  // auth.users is global (no tenant scope) — withSystemDb bypasses RLS
  // deliberately. — OXA-1515
  const reqHeaders = await headers();

  const prefCtx: CapabilityContext = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  const [rows, connectedAccountsState, prefs] = await Promise.all([
    withSystemDb((tx) =>
      tx
        .select({
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.users)
        .where(eq(schema.users.id, session.user.id))
        .limit(1),
    ),
    fetchConnectedAccountsState(session.user.id, reqHeaders),
    userPreferencesReadHandler({}, prefCtx),
  ]);

  const user = rows[0];
  if (!user) {
    // Defensive: should never happen for an authenticated user
    return (
      <p className="text-sm text-muted-foreground">Unable to load profile. Please sign in again.</p>
    );
  }

  return (
    <ProfileForm
      userId={session.user.id}
      initialDisplayName={user.displayName ?? ""}
      email={user.email}
      initialAvatarUrl={user.avatarUrl ?? ""}
      connectedAccountsState={connectedAccountsState}
      timezone={prefs.timezone}
      language={prefs.language}
    />
  );
}
