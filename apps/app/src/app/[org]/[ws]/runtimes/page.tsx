import { requireViewer } from "@/server/viewer";
import { permanentRedirectTo } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";

// Runtimes is a tab of the Agents page, not a page of its own (roadmap mockups
// `agents?tab=runtimes`). This route still resolves, for a member of the
// workspace, and moves to the tab. One runtime's page stays at
// `runtimes/<id>`.
export default async function RuntimesPage({
  params,
}: PageProps<"/[org]/[ws]/runtimes">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  permanentRedirectTo(routes.runtimes(ctx.orgSlug, ctx.wsSlug));
}
