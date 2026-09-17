import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";
import { requestScopeSlugs } from "@/lib/request-path";

/**
 * Workspace Settings root → General. Slugs come from the request URL, NOT
 * `params` — see lib/request-path.ts (awaiting `params` before `redirect()`
 * 500s the shell under Cache Components).
 */
export default async function SettingsRoot() {
  const { orgSlug, workspaceSlug } = await requestScopeSlugs();
  if (!orgSlug || !workspaceSlug) redirect("/");
  redirect(workspace.settings.general({ orgSlug, workspaceSlug }));
}
