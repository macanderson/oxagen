import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Marketplace → Browse (moved). The catalog is now the Agent Tools side of
 * the Marketplace. Kept as a redirect for old links/bookmarks.
 */
export default async function MarketplaceBrowseRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.marketplace.agentTools({ orgSlug, workspaceSlug }));
}
