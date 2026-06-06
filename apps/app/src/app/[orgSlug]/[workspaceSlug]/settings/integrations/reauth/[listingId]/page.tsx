import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { Plug, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

// Sentinel workspaceId for org-only DB queries. — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export const dynamic = "force-dynamic";

export default async function ReauthPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; listingId: string }>;
}) {
  const { orgSlug, workspaceSlug, listingId } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Resolve the listing by publicId (the listingId param from the URL).
  // pluginOrgListings uses idMixin which emits `public_id` (camelCase: publicId).
  const [listing] = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginOrgListings)
          .where(
            and(
              eq(schema.pluginOrgListings.publicId, listingId),
              eq(schema.pluginOrgListings.orgId, org.id),
            ),
          )
          .limit(1),
      ),
  ).catch(() => [] as (typeof schema.pluginOrgListings.$inferSelect)[]);

  if (!listing) notFound();

  // OAuth start route — Plan 4 ships /api/v1/plugins/oauth/start.
  // The workspaceId is passed so the credential row is scoped to this workspace.
  const oauthStartUrl = `/api/v1/plugins/oauth/start?orgListingId=${listing.id}&workspaceId=${ws.id}`;

  return (
    <div
      className="flex flex-col items-center justify-center gap-6 py-20 text-center"
      data-testid="reauth-page"
    >
      {/* Plugin icon */}
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        {listing.iconUrl ? (
          <img
            src={listing.iconUrl}
            alt=""
            className="h-8 w-8 rounded object-contain"
            aria-hidden="true"
          />
        ) : (
          <Plug className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        )}
      </div>

      {/* Copy */}
      <div className="flex flex-col gap-2 max-w-sm">
        <h1 className="text-lg font-semibold" data-testid="reauth-plugin-title">
          {listing.title ?? listing.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          Your connection to{" "}
          <strong>{listing.title ?? listing.name}</strong> has expired or been revoked.
          Reconnect to restore access.
        </p>
      </div>

      {/* Action */}
      {listing.authKind === "oauth" ? (
        <Button
          render={<Link href={oauthStartUrl} />}
          data-testid="reauth-reconnect-btn"
        >
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Reconnect {listing.title ?? listing.name}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="reauth-secret-fallback">
          Contact your org admin to update the API key for this plugin in{" "}
          <Link
            href={`/${orgSlug}/settings/plugins`}
            className="text-primary underline"
          >
            Org Settings → Plugins
          </Link>
          .
        </p>
      )}
    </div>
  );
}
