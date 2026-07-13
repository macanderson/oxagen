import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";
import { requestScopeSlugs } from "@/lib/request-path";

/**
 * Marketplace root → its first tab, Agent Tools. Slugs come from the request
 * URL, NOT `params` — see lib/request-path.ts (awaiting `params` before
 * `redirect()` 500s the shell under Cache Components).
 */
export default async function MarketplaceRootPage() {
  const { orgSlug, workspaceSlug } = await requestScopeSlugs();
  if (!orgSlug || !workspaceSlug) redirect("/");
  redirect(workspace.marketplace.agentTools({ orgSlug, workspaceSlug }));
}
