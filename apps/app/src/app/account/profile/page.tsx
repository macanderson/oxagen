import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { ProfileForm } from "./profile-form";
import { fetchConnectedAccountsState } from "./security-action";

export default async function AccountProfilePage() {
  const session = await getSessionOrRedirect();

  // Fetch profile data and linked accounts in parallel.
  const reqHeaders = await headers();
  const [rows, connectedAccountsState] = await Promise.all([
    db()
      .select({
        email: schema.users.email,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.user.id))
      .limit(1),
    fetchConnectedAccountsState(session.user.id, reqHeaders),
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
    />
  );
}
