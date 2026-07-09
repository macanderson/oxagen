import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/** Visiting the Marketplace root redirects to its first tab: Agent Tools. */
export default async function MarketplaceRootPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.marketplace.agentTools({ orgSlug, workspaceSlug }));
}
