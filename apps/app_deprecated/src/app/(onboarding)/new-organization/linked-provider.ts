import "server-only";
import { eq } from "drizzle-orm";
// tenancy: unscoped seam (identity resolution — auth.accounts is a global
// identity table with no RLS; reads the user's own linked OAuth providers)
import { withSystemDb, schema } from "@oxagen/database";
import type { SignupProvider } from "@/lib/oauth-prefill";

/**
 * Return the social provider linked to a user, preferring Google then GitHub.
 * Returns null when the user only has the `credential` (email/password)
 * provider or no linked OAuth account. Used to attribute prefilled profile
 * values on the new-organization form.
 */
export async function getLinkedSocialProvider(
  userId: string,
): Promise<SignupProvider | null> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ providerId: schema.accounts.providerId })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId)),
  );
  const providers = new Set(rows.map((r) => r.providerId));
  if (providers.has("google")) return "google";
  if (providers.has("github")) return "github";
  return null;
}
