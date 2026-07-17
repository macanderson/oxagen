/**
 * breadcrumbs.ts — server-only breadcrumb builders.
 *
 * Resolving a workspace's display name is a DB lookup (resolveWorkspace), so
 * this lives server-side and is imported ONLY by async layouts, never a client
 * component. resolveOrg/resolveWorkspace are request-cached, so calling them
 * here dedupes with the pages under the layout — no extra round-trip.
 */
import "server-only";
import type { BreadcrumbItem } from "@/components/ui/breadcrumb";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { workspace } from "@/lib/routes";

/**
 * The workspace breadcrumb item, labelled by the workspace's DISPLAY NAME (not
 * its URL slug), so the trail reads the same as the topbar workspace pill (e.g.
 * "Default", not "default"). Links to the workspace's Ask home.
 */
export async function workspaceCrumb(
  orgSlug: string,
  workspaceSlug: string,
): Promise<BreadcrumbItem> {
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  return {
    label: ws.name,
    href: workspace.ask({ orgSlug, workspaceSlug }),
  };
}
