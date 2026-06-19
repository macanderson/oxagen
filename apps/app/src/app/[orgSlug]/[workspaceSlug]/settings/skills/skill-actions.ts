"use server";
/**
 * skill-actions.ts — server actions for Workspace → Settings → Skills.
 *
 * All operations delegate to skill lifecycle contracts (skill.workspace.*,
 * skill.version.*, skill.export, skill.metrics.read). Explicit
 * assertOrgMember/role gates are present because apps/app skips IAM.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, and } from "drizzle-orm";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOT_AUTHORIZED = "Only workspace owners and admins can manage skills.";

function buildCtx(opts: { orgId: string; workspaceId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

async function resolveAndAuthWorkspace(orgSlug: string, workspaceSlug: string) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

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

  return { session, org, ws, canManage };
}

function skillsPath(ctx: Required<ScopeContext>): string {
  return workspace.settings.skills(ctx);
}

// ── installSkill ──────────────────────────────────────────────────────────────

const InstallSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
});

export async function installSkill(
  input: z.infer<typeof InstallSkillSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = InstallSkillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    await invoke("skill.workspace.install", { skillSlug: parsed.data.skillSlug }, ctx, {
      surface: "agent",
    });
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(skillsPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Install failed" };
  }
}

// ── editSkill (create new version from content) ───────────────────────────────

const EditSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
  content: z.string().min(1).max(500_000),
  commitMessage: z.string().max(500).optional(),
});

export async function editSkill(
  input: z.infer<typeof EditSkillSchema>,
): Promise<{ ok: boolean; versionId?: string; version?: string; error?: string }> {
  const parsed = EditSkillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    const out = await invoke(
      "skill.version.upload",
      {
        skillSlug: parsed.data.skillSlug,
        content: parsed.data.content,
        commitMessage: parsed.data.commitMessage,
      },
      ctx,
      { surface: "agent" },
    );
    const typed = out as { versionId: string; version: string };
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(skillsPath(routeCtx));
    return { ok: true, versionId: typed.versionId, version: typed.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Edit failed" };
  }
}

// ── activateVersion ───────────────────────────────────────────────────────────

const ActivateVersionSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
  versionId: z.string().min(1),
});

export async function activateVersion(
  input: z.infer<typeof ActivateVersionSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = ActivateVersionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    await invoke(
      "skill.version.activate",
      { skillSlug: parsed.data.skillSlug, versionId: parsed.data.versionId },
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(skillsPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Activate failed" };
  }
}

// ── exportSkill ───────────────────────────────────────────────────────────────

const ExportSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
  versionId: z.string().optional(),
});

export async function exportSkill(
  input: z.infer<typeof ExportSkillSchema>,
): Promise<{ ok: boolean; content?: string; filename?: string; error?: string }> {
  const parsed = ExportSkillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  // Read is allowed for all workspace members — no canManage check here.

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    const out = await invoke(
      "skill.export",
      { skillSlug: parsed.data.skillSlug, versionId: parsed.data.versionId },
      ctx,
      { surface: "agent" },
    );
    const typed = out as { content: string; filename: string };
    return { ok: true, content: typed.content, filename: typed.filename };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Export failed" };
  }
}
