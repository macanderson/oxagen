import { requireViewer } from "@/server/viewer";
import { permanentRedirectTo } from "@/shared/navigation";
import { firstParam, routes } from "@/shared/safe-path";

// Skills is a tab of Steering, not a page of its own (MC spec §10.7; roadmap
// pages/skills.md). This route still resolves, for a member of the workspace,
// and moves to the tab with the inventory page it named. The capability
// behind it, list_skills, is unchanged and still bound to the tab.
export default async function SkillsPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/skills">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  const cursor = firstParam(query.cursor);
  permanentRedirectTo(
    routes.skills(
      ctx.orgSlug,
      ctx.wsSlug,
      cursor === undefined ? undefined : { cursor },
    ),
  );
}
