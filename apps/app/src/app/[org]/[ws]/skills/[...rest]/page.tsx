import { notFound } from "next/navigation";
import { SKILL_PAGE } from "@/data/contracts/skills";
import { resolveSteeringRoute } from "@/features/steering";
import { requireViewer } from "@/server/viewer";
import { permanentRedirectTo } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";

// The addresses beneath the old Skills page (roadmap pages/steering.md,
// "Functionality"): `/skills/<view>` and `/skills/<id>/source` still resolve,
// for a member of the workspace, on the Skills shelf of the Steering library.
// The path is read the way `/steering/skills/…` reads it, so a segment that
// names no view and no skill is a 404 here too rather than a guess.
export default async function SkillsViewPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/skills/[...rest]">) {
  const { org, ws, rest } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  const at = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const route = resolveSteeringRoute(at, ["skills", ...rest], query);
  if (route.kind === "not_found") notFound();
  if (route.kind === "redirect") permanentRedirectTo(route.to);
  const { view } = route;
  permanentRedirectTo(
    routes.steering(at.org, at.ws, {
      tab: "skills",
      skill: view.skill ?? undefined,
      view:
        view.skill === null && view.skillView !== "catalog"
          ? view.skillView
          : undefined,
      // The inventory's page size, left off at its default (#4693).
      rows:
        view.skill === null && view.rows !== SKILL_PAGE
          ? String(view.rows)
          : undefined,
      cursor: view.cursor ?? undefined,
    }),
  );
}
