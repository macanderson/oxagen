import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";
import { requestScopeSlugs } from "@/lib/request-path";

/**
 * Workbench root redirects to Agents — the section's front door (defaultTab
 * map). Slugs come from the request URL, NOT `params`: awaiting `params` before
 * `redirect()` 500s the shell under Cache Components. See lib/request-path.ts.
 */
export default async function WorkbenchPage() {
  const { orgSlug, workspaceSlug } = await requestScopeSlugs();
  if (!orgSlug || !workspaceSlug) redirect("/");
  redirect(workspace.workbench.agents({ orgSlug, workspaceSlug }));
}
