import { requireViewer } from "@/server/viewer";
import { permanentRedirectTo } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";

// One runtime opens in the drawer over the Agents page's Runtimes tab (roadmap
// mockups `agt-runtime`), not on a page of its own. This route still
// resolves, for a member of the workspace, and moves to the drawer with the
// same id: a host enrollment (`tch_…`) or a named runtime (`rtm_…`). The
// drawer answers an id the workspace does not hold.
export default async function RuntimePage({
  params,
}: {
  params: Promise<{ org: string; ws: string; runtime: string }>;
}) {
  const { org, ws, runtime } = await params;
  const ctx = await requireViewer(org, ws);
  permanentRedirectTo(routes.runtime(ctx.orgSlug, ctx.wsSlug, runtime));
}
