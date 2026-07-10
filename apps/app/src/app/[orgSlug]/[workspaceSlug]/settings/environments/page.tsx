import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/**
 * Environments moved to Workbench → Environments (first-class page) — env
 * config is a build concern, not a settings one. This route is kept as a
 * redirect for old links/bookmarks. Sandbox templates live on
 * Workbench → Sandboxes.
 */
export default async function EnvironmentsSettingsRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.workbench.environments({ orgSlug, workspaceSlug }));
}
