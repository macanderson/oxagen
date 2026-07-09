import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Marketplace → Installed (moved). Managing installed capability packs now
 * lives in Studio → Agent Tools → Capabilities. Kept as a redirect for old
 * links/bookmarks.
 */
export default async function MarketplaceInstalledRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.studio.tools.capabilities({ orgSlug, workspaceSlug }));
}
