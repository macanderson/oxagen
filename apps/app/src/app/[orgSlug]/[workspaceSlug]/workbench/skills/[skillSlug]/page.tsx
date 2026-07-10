import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Workbench → Skills → [skillSlug] (moved). Skill detail now lives inside the
 * Agent Tools hub. Kept as a redirect for old links/bookmarks.
 */
export default async function WorkbenchSkillDetailRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; skillSlug: string }>;
}) {
  const { orgSlug, workspaceSlug, skillSlug } = await params;
  redirect(workspace.workbench.tools.skill({ orgSlug, workspaceSlug }, skillSlug));
}
