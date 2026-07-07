/**
 * page.tsx — Workspace → Studio → Skills.
 *
 * Lists all skills installed in the workspace: name, source/provenance,
 * active version, last updated, last used, and usage count, and offers a
 * "+ New skill" create flow. Data is loaded via
 * invoke('skill.workspace.list') + invoke('skill.metrics.read').
 *
 * Moved from settings/skills — the old route now redirects here (see
 * settings/skills/page.tsx).
 */
import type { Metadata } from "next";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { resolveStudioScope } from "@/lib/studio/scope";
import { SkillsPanel } from "./skills-panel";
import type { SkillRow } from "./skills-panel";
import { createSkillAction, draftSkillAction } from "./skill-actions";

export const metadata: Metadata = {
  title: "Skills | Studio",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

interface SkillListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: string;
  activeVersion: string | null;
  updatedAt: string | null;
}

interface SkillMetrics {
  slug: string;
  lastUsedAt: string | null;
  usageCount: number;
}

export default async function StudioSkillsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveStudioScope(orgSlug, workspaceSlug);

  // Fetch installed skills list.
  let skillItems: SkillListItem[] = [];
  try {
    const result = await invoke("skill.workspace.list", {}, ctx, { surface: "agent" });
    const typed = result as { skills: SkillListItem[] };
    skillItems = typed.skills ?? [];
  } catch {
    // Degrade gracefully — show empty state.
  }

  // Fetch usage metrics for all skills (non-fatal).
  const metricsMap = new Map<string, SkillMetrics>();
  if (skillItems.length > 0) {
    try {
      const metricsResult = await invoke(
        "skill.metrics.read",
        { slugs: skillItems.map((s) => s.slug) },
        ctx,
        { surface: "agent" },
      );
      const typed = metricsResult as { metrics: SkillMetrics[] };
      for (const m of typed.metrics ?? []) {
        metricsMap.set(m.slug, m);
      }
    } catch {
      // Non-fatal: metrics default to zero.
    }
  }

  // Merge skills + metrics.
  const rows: SkillRow[] = skillItems.map((s) => {
    const m = metricsMap.get(s.slug);
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      source: s.source,
      activeVersion: s.activeVersion,
      updatedAt: s.updatedAt,
      lastUsedAt: m?.lastUsedAt ?? null,
      usageCount: m?.usageCount ?? 0,
    };
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Skills</h2>
        <p className="text-sm text-muted-foreground">
          Agent skills available in this workspace. Skills extend what agents can do by providing
          reusable, versioned prompt playbooks — author your own or install from the marketplace.
        </p>
      </div>
      <SkillsPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        skills={rows}
        canManage={canManage}
        createAction={createSkillAction}
        draftAction={draftSkillAction}
      />
    </div>
  );
}
