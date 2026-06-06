"use server";
/**
 * integration-actions.ts — server actions for Workspace → Settings → Integrations.
 *
 * Enables/disables org-installed plugins at workspace scope and handles
 * credential entry (API key / secret). Role-gated to workspace owners and
 * admins (same pattern as models-action.ts).
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke() can resolve its handlers. Mirrors models-action.ts.
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const NOT_AUTHORIZED = "Only workspace owners and admins can manage integrations.";

// ── setWorkspacePluginEnabledAction ───────────────────────────────────────────

const SetWsEnabledSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function setWorkspacePluginEnabledAction(
  input: z.infer<typeof SetWsEnabledSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SetWsEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, enabled } = parsed.data;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
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
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return { ok: false, error: NOT_AUTHORIZED };
    }

    const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    try {
      await invoke(
        "plugin.workspace.set_enabled",
        { orgListingId, enabled },
        ctx,
        { surface: "agent" },
      );
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.integrations(routeCtx));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Update failed",
      };
    }
  });
}

// ── setSecretAction ───────────────────────────────────────────────────────────

const SetSecretSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  secret: z.string().min(1).max(2048),
});

export async function setSecretAction(
  input: z.infer<typeof SetSecretSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SetSecretSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, secret } = parsed.data;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
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
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return { ok: false, error: NOT_AUTHORIZED };
    }

    const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    try {
      await invoke(
        "plugin.credential.set_secret",
        { orgListingId, authKind: "secret", secret },
        ctx,
        { surface: "agent" },
      );
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.integrations(routeCtx));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to save secret",
      };
    }
  });
}
