import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { isRenderableImageUrl } from "@/lib/plugin-icon";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { Plug, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import Image from "next/image";


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
  // pluginInstalledPlugins uses idMixin which emits `public_id` (camelCase: publicId).
  const [listing] = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginInstalledPlugins)
          .where(
            and(
              eq(schema.pluginInstalledPlugins.publicId, listingId),
              eq(schema.pluginInstalledPlugins.orgId, org.id),
              eq(schema.pluginInstalledPlugins.workspaceId, ws.id),
            ),
          )
          .limit(1),
      ),
  ).catch(() => [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[]);

  if (!listing) notFound();

  // OAuth authorize route (Plan 4): /api/v1/mcp/oauth/authorize. It resolves the
  // workspace from orgSlug+workspaceSlug and scopes the credential to it.
  const oauthStartUrl = `/api/v1/mcp/oauth/authorize?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}&orgListingId=${listing.id}`;

  return (
    <div
      className="flex flex-col items-center justify-center gap-6 py-20 text-center"
      data-testid="reauth-page"
    >
      {/* Plugin icon */}
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        {isRenderableImageUrl(listing.iconUrl) ? (
          <Image
            src={listing.iconUrl}
            alt=""
            width={32}
            height={32}
            // Catalog icons are arbitrary remote URLs not in next.config
            // remotePatterns — bypass the optimizer.
            unoptimized
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
            href={`/${orgSlug}/${workspaceSlug}/settings/plugins`}
            className="text-primary underline"
          >
            Workspace Settings → Plugins
          </Link>
          .
        </p>
      )}
    </div>
  );
}
