/**
 * page.tsx — Workspace → Workbench → Skills.
 *
 * Lists all skills installed in the workspace: name, source/provenance,
 * active version, last updated, last used, and usage count, and offers a
 * "+ New skill" create flow. Data is loaded via
 * invoke('list_workspace_skills') + invoke('get_skill_metrics').
 *
 * Moved from settings/skills — the old route now redirects here (see
 * settings/skills/page.tsx).
 */
import type { Metadata } from "next";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { SkillsPanel } from "./skills-panel";
import type { SkillRow } from "./skills-panel";
import { createSkillAction, draftSkillAction } from "./skill-actions";

export const metadata: Metadata = {
  title: "Skills | Agent Tools",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

interface SkillListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: string;
  installedFromSlug: string | null;
  activeVersion: string | null;
  updatedAt: string | null;
}

interface SkillMetrics {
  slug: string;
  lastUsedAt: string | null;
  usageCount: number;
}

export default async function WorkbenchSkillsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );

  // Fetch installed skills list.
  //
  // NOTE: do NOT pass { surface: "agent" } here. list_workspace_skills (like the
  // other skill read/manage capabilities) is exposed only on ["api","mcp"], so
  // asserting the "agent" surface makes the kernel throw surface_denied — which
  // the catch below would swallow into a permanently-empty list (the bug where
  // created skills never appeared). apps/app is a trusted server caller; it omits
  // opts.surface so no surface allowlist is enforced (see equip-sources.ts).
  let skillItems: SkillListItem[] = [];
  try {
    const result = await invoke("list_workspace_skills", {}, ctx);
    const typed = result as { skills: SkillListItem[] };
    skillItems = typed.skills ?? [];
  } catch {
    // Degrade gracefully — show empty state.
  }

  // Fetch usage metrics for all skills (non-fatal). get_skill_metrics takes an
  // optional skillId (omit → workspace-wide aggregation) and returns a `skills`
  // array keyed per skill; we index it by slug to merge into the table.
  const metricsMap = new Map<string, SkillMetrics>();
  if (skillItems.length > 0) {
    try {
      const metricsResult = await invoke("get_skill_metrics", {}, ctx);
      const typed = metricsResult as { skills: SkillMetrics[] };
      for (const m of typed.skills ?? []) {
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
      installedFromSlug: s.installedFromSlug ?? null,
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
          Agent skills available in this workspace. Skills extend what agents
          can do by providing reusable, versioned prompt playbooks — author your
          own or install from the marketplace.
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
