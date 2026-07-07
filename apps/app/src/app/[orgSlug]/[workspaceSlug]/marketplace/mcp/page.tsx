import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Marketplace → MCP Servers (moved). MCP server management now lives in
 * Studio → Agent Tools → MCP Servers. Kept as a redirect for old
 * links/bookmarks.
 */
export default async function MarketplaceMcpRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.studio.tools.mcp({ orgSlug, workspaceSlug }));
}
