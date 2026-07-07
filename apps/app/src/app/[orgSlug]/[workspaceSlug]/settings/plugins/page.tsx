import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Settings → Plugins (moved twice). Plugin management became the Marketplace,
 * then consolidated into Studio → Agent Tools: installed capability packs live
 * under the Capabilities tab. Kept as a redirect for old links/bookmarks.
 */
export default async function WorkspacePluginsRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.studio.tools.capabilities({ orgSlug, workspaceSlug }));
}
