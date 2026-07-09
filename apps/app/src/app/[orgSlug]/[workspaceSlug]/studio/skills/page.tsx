import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Studio → Skills (moved). Skills now live inside the Agent Tools hub
 * (Studio → Agent Tools → Skills). Kept as a redirect for old
 * links/bookmarks.
 */
export default async function StudioSkillsRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.studio.tools.skills({ orgSlug, workspaceSlug }));
}
