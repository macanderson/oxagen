import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { notifyOrgManagers, reauthEmailTemplate } from "@oxagen/notifications";

/**
 * Flip a credential row to needs_reauth and notify org managers.
 *
 * Plan 4 established this signature (status flip); Plan 5 wires notification.
 * Notification failure does NOT propagate — the credential flip is the
 * authoritative action; notification is best-effort.
 */
export async function markCredentialNeedsReauth(
  workspaceId: string,
  orgListingId: string,
): Promise<void> {
  // 1. Flip credential status.
  await withSystemDb(async (tx) => {
    await tx
      .update(schema.mcpCredentials)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(
        and(
          eq(schema.mcpCredentials.workspaceId, workspaceId),
          eq(schema.mcpCredentials.orgListingId, orgListingId),
        ),
      );
  });

  // 2. Resolve org listing for notification context (orgId + server name).
  const listing = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({
        orgId: schema.pluginInstalledPlugins.orgId,
        name: schema.pluginInstalledPlugins.name,
        title: schema.pluginInstalledPlugins.title,
      })
      .from(schema.pluginInstalledPlugins)
      .where(eq(schema.pluginInstalledPlugins.id, orgListingId))
      .limit(1);
    return row ?? null;
  });

  if (!listing) {
    // The listing may have been deleted; skip notification silently.
    return;
  }

  const serverName = listing.title ?? listing.name;
  const appUrl = process.env["APP_URL"] ?? "https://oxagen-v2-app.vercel.app";

  // The deep-link goes to the workspace re-auth page; workspaceId is the uuid.
  // The re-auth route accepts the orgListingId as a path segment (Plan 4 Task 7).
  const deepLink = `${appUrl}/settings/integrations/reauth/${orgListingId}`;

  const { subject, text, html } = reauthEmailTemplate({
    serverName,
    reauthUrl: deepLink,
    orgName: listing.orgId, // Org name requires a join; use orgId as fallback
    // VERIFY: for a richer email, add an org name join here or pass orgName
    // as an optional parameter once Plan 6 adds settings UI context.
  });

  // 3. Notify org managers — fire and forget; error logged inside.
  notifyOrgManagers({
    orgId: listing.orgId,
    workspaceId,
    kind: "security",
    title: subject,
    body: text,
    deepLink,
    emailHtml: html,
  }).catch(() => {
    // Already logged inside notifyOrgManagers; do not propagate.
  });
}
