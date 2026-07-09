import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Workbench → Skills (moved). Skills now live inside the Agent Tools hub
 * (Workbench → Agent Tools → Skills). Kept as a redirect for old
 * links/bookmarks.
 */
export default async function WorkbenchSkillsRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.workbench.tools.skills({ orgSlug, workspaceSlug }));
}
