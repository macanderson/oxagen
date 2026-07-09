/**
 * page.tsx — Workspace → Studio → Skills → [skillSlug] detail view.
 *
 * Shows version history, edit-to-new-version, activate, and download for a
 * single installed skill. Data is loaded via:
 *   invoke('list_skill_versions')   — version history
 *   invoke('get_skill_version')    — active version content
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
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveStudioScope } from "@/lib/studio/scope";
import { SkillDetailPanel } from "./skill-detail-panel";
import type { SkillDetailData, SkillVersion } from "./skill-detail-panel";
import { editSkill, activateVersion, exportSkill } from "../skill-actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; skillSlug: string }>;
}): Promise<Metadata> {
  const { skillSlug } = await params;
  return { title: `${skillSlug} | Skills | Studio` };
}

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; skillSlug: string }>;
}

export default async function StudioSkillDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, skillSlug } = await params;
  const { ctx, canManage } = await resolveStudioScope(orgSlug, workspaceSlug);

  // Fetch skill detail + active version content.
  let skill: SkillDetailData | null = null;
  try {
    const out = await invoke("get_skill_version", { skillSlug }, ctx, { surface: "agent" });
    const typed = out as {
      id: string;
      slug: string;
      name: string;
      description: string;
      source: string;
      activeVersion: string | null;
      content: string | null;
      updatedAt: string | null;
    };
    skill = typed;
  } catch {
    // Could not load skill — show not-found below.
  }

  // Fetch version history.
  let versions: SkillVersion[] = [];
  if (skill) {
    try {
      const out = await invoke("list_skill_versions", { skillSlug }, ctx, { surface: "agent" });
      const typed = out as {
        versions: Array<{
          id: string;
          version: string;
          commitMessage: string | null;
          createdAt: string;
          createdByEmail: string | null;
          isActive: boolean;
        }>;
      };
      versions = typed.versions ?? [];
    } catch {
      // Non-fatal: render with empty history.
    }
  }

  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
  const backHref = workspace.studio.tools.skills(routeCtx);

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
          Skill{" "}
          <span className="font-mono">{decodeURIComponent(skillSlug)}</span> was not found in this
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
