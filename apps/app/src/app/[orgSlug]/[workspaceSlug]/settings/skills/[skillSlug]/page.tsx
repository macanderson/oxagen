/**
 * page.tsx — Workspace → Settings → Skills → [skillSlug] detail view.
 *
 * Shows version history, edit-to-new-version, activate, and download for a
 * single installed skill. Data is loaded via:
 *   invoke('skill.version.list')   — version history
 *   invoke('skill.version.get')    — active version content
 *
 * Passes server actions (editSkill, activateVersion, exportSkill) as props so
 * the "use client" SkillDetailPanel component can call them without crossing
 * the RSC/client boundary.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, and } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
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
  return { title: `${skillSlug} | Skills | Workspace Settings` };
}

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; skillSlug: string }>;
}

export default async function SkillDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, skillSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Determine manage permission (owner/admin only).
  const wsRoleRows = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.workspaceUsers.role })
          .from(schema.workspaceUsers)
          .where(
            and(
              eq(schema.workspaceUsers.workspaceId, ws.id),
              eq(schema.workspaceUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );

  const wsRole = wsRoleRows[0]?.role ?? "";
  const canManage = ["owner", "admin"].includes(wsRole.toLowerCase());

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Fetch skill detail + active version content.
  let skill: SkillDetailData | null = null;
  try {
    const out = await invoke("skill.version.get", { skillSlug }, ctx, { surface: "agent" });
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
      const out = await invoke("skill.version.list", { skillSlug }, ctx, { surface: "agent" });
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

  const ctx2: Required<ScopeContext> = { orgSlug, workspaceSlug };
  const backHref = workspace.settings.skills(ctx2);

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
