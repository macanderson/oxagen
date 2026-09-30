import { requireViewer } from "@/server/viewer";
import { permanentRedirectTo } from "@/shared/navigation";
import { firstParam, routes } from "@/shared/safe-path";

// Skills is a tab of Steering, not a page of its own (MC spec §10.7; roadmap
// pages/skills.md). This route still resolves, for a member of the workspace,
// and moves to the tab with the inventory page and page size it named. The
// tab reads the size and falls back to its default for one it does not offer
// (#4693). The capability behind it, list_skills, is still bound to the tab.
export default async function SkillsPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/skills">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  permanentRedirectTo(
    routes.skills(ctx.orgSlug, ctx.wsSlug, {
      cursor: firstParam(query.cursor),
      rows: firstParam(query.rows),
    }),
  );
}
