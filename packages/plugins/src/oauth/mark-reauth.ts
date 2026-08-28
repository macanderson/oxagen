import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { notifyOrgManagers, reauthEmailTemplate } from "@oxagen/notifications";

/**
 * Flip a credential row to needs_reauth and notify org managers.
 *
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

  // 2. Resolve notification context: server name, org name, and — crucially —
  // the org + workspace SLUGS. The deep link must be a real, navigable app URL
  // (/{orgSlug}/{workspaceSlug}/workbench/tools/mcp), so raw UUIDs won't do.
  // Join the listing → organization (slug + name) and the workspace (slug).
  const listing = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({
        orgId: schema.pluginInstalledPlugins.orgId,
        name: schema.pluginInstalledPlugins.name,
        title: schema.pluginInstalledPlugins.title,
        orgSlug: schema.organizations.slug,
        orgName: schema.organizations.name,
        workspaceSlug: schema.workspaces.slug,
      })
      .from(schema.pluginInstalledPlugins)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.pluginInstalledPlugins.orgId),
      )
      // The workspace is matched by the reauth target (workspaceId), not the
      // listing (a listing is org-scoped and can span workspaces).
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, workspaceId))
      .where(eq(schema.pluginInstalledPlugins.id, orgListingId))
      .limit(1);
    return row ?? null;
  });

  if (!listing) {
    // The listing may have been deleted; skip notification silently.
    return;
  }

  const serverName = listing.title ?? listing.name;
  const appUrl = process.env["APP_URL"] ?? "https://app.oxagen.sh";

  // Deep-link to the real MCP Servers page for this workspace, with ?reauth=
  // highlighting the server that needs re-authentication. That page renders the
  // "Re-authenticate" action (→ GET /api/v1/mcp/oauth/authorize) for the row.
  const deepLink =
    `${appUrl}/${listing.orgSlug}/${listing.workspaceSlug}` +
    `/workbench/tools/mcp?reauth=${encodeURIComponent(orgListingId)}`;

  const { subject, text, html } = reauthEmailTemplate({
    serverName,
    reauthUrl: deepLink,
    orgName: listing.orgName,
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
