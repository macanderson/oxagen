/**
 * page.tsx — Workspace → Workbench → Skills → [skillSlug] detail view.
 *
 * Shows version history, edit-to-new-version (draft + confirm-pin), activate,
 * and download for a single installed skill. Data is loaded via:
 *   invoke('get_skill_version')    — skill meta + pinned active version content
 *                                    (slug-based; version_id omitted → active)
 *   invoke('list_skill_versions')  — version history
 *
 * Passes server actions (editSkill, activateVersion, exportSkill) as props so
 * the "use client" SkillDetailPanel component can call them without crossing
 * the RSC/client boundary. Moved from settings/skills/[skillSlug] — the old
 * route now redirects here (see settings/skills/[skillSlug]/page.tsx).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import type { SkillVersionGetOutput } from "@oxagen/oxagen/contracts/skill.version.get";
import type { SkillVersionListOutput } from "@oxagen/oxagen/contracts/skill.version.list";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { SkillDetailPanel } from "./skill-detail-panel";
import type { SkillDetailData, SkillVersion } from "./skill-detail-panel";
import { editSkill, activateVersion, exportSkill } from "../skill-actions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    skillSlug: string;
  }>;
}): Promise<Metadata> {
  const { skillSlug } = await params;
  return { title: `${skillSlug} | Skills | Workbench` };
}

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    skillSlug: string;
  }>;
}

export default async function WorkbenchSkillDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, skillSlug } = await params;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  const slug = decodeURIComponent(skillSlug);

  // Fetch skill meta + active-version content in one call. skill_id accepts
  // the slug (dual publicId/slug resolution); version_id omitted resolves the
  // pinned active version, falling back to latest.
  //
  // No { surface: "agent" }: this capability is exposed on ["api","mcp"] only,
  // so asserting the agent surface throws surface_denied. apps/app omits
  // opts.surface as a trusted server caller.
  let skill: SkillDetailData | null = null;
  try {
    const out = (await invoke(
      "get_skill_version",
      { skill_id: slug },
      ctx,
    )) as SkillVersionGetOutput;
    skill = {
      id: out.skill_id,
      slug: out.skill_slug,
      name: out.skill_name,
      description: out.skill_description,
      source: out.skill_source,
      installedFromSlug: out.installedFromSlug,
      activeVersion: `v${out.versionNumber}`,
      activeVersionIsPinned: out.isActive,
      content: out.content,
      updatedAt: out.createdAt,
    };
  } catch (err) {
    // Only a genuinely missing skill renders the not-found state. Anything
    // else (invalid input, authz, kernel failure) must surface — swallowing
    // it here is exactly how a contract mismatch masqueraded as "skill not
    // found in this workspace" for every skill.
    const message = err instanceof Error ? err.message : "";
    if (!/not found/i.test(message)) throw err;
  }

  // Fetch version history.
  let versions: SkillVersion[] = [];
  if (skill) {
    try {
      const out = (await invoke(
        "list_skill_versions",
        { skill_id: slug },
        ctx,
      )) as SkillVersionListOutput;
      versions = (out.versions ?? []).map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        version: `v${v.versionNumber}`,
        commitMessage: v.changeSummary,
        createdAt: v.createdAt,
        createdByEmail: v.createdByEmail,
        isActive: v.isActive,
      }));
    } catch {
      // Non-fatal: render with empty history.
    }
  }

  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
  const backHref = workspace.workbench.tools.skills(routeCtx);

  if (!skill) {
    return (
      <div className="flex flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          render={<Link href={backHref} />}
        >
          <ChevronLeft className="h-4 w-4 mr-1" aria-hidden="true" />
          All Skills
        </Button>
        <p className="text-sm text-muted-foreground">
          Skill <span className="font-mono">{slug}</span> was not found in this
          workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Back link */}
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        render={<Link href={backHref} data-testid="skill-detail-back-link" />}
      >
        <ChevronLeft className="h-4 w-4 mr-1" aria-hidden="true" />
        All Skills
      </Button>

      <SkillDetailPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        skill={skill}
        versions={versions}
        canManage={canManage}
        editAction={editSkill}
        activateAction={activateVersion}
        exportAction={exportSkill}
      />
    </div>
  );
}
