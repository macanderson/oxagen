/**
 * page.tsx — Workspace → Settings → Skills (moved).
 *
 * Skills now lives under Workbench, alongside Agents and Tools — it feeds the
 * Agent Builder's Equip step. This route is kept as a redirect for old
 * links/bookmarks. See workbench/skills/page.tsx for the live implementation.
 */
import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkspaceSkillsRedirectPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.workbench.tools.skills({ orgSlug, workspaceSlug }));
}
