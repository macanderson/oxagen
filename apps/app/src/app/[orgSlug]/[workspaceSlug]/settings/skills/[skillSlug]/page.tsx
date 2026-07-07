/**
 * page.tsx — Workspace → Settings → Skills → [skillSlug] (moved).
 *
 * Skill detail now lives under Studio. This route is kept as a redirect for
 * old links/bookmarks. See studio/skills/[skillSlug]/page.tsx for the live
 * implementation.
 */
import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; skillSlug: string }>;
}

export default async function WorkspaceSkillDetailRedirectPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, skillSlug } = await params;
  redirect(workspace.studio.skill({ orgSlug, workspaceSlug }, skillSlug));
}
