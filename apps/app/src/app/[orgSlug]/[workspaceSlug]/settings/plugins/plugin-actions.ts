"use server";
/**
 * plugin-actions.ts — server actions for Workspace → Settings → Plugins.
 *
 * Workspace-scoped plugin management: install from marketplace, toggle enabled
 * state, and uninstall. Delegates to org-level contracts since workspace plugins
 * are a view over the org allow-list with per-workspace enable/disable state.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOT_AUTHORIZED = "Only workspace owners and admins can manage plugins.";
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

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

/**
 * Resolve a listing's plugin_type so toggle/uninstall can route to the correct
 * contract. Capability packs are org-scoped (Phase 1): they have no per-workspace
 * mcp_servers row and `plugin.workspace.set_enabled` THROWS for them — they must
 * go through the org-level `plugin.org.*` contracts instead.
 */
async function getListingPluginType(
  orgId: string,
  orgListingId: string,
): Promise<string | null> {
  const rows = await runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select({ pluginType: schema.pluginOrgListings.pluginType })
        .from(schema.pluginOrgListings)
        .where(
          and(
            eq(schema.pluginOrgListings.id, orgListingId),
            eq(schema.pluginOrgListings.orgId, orgId),
          ),
        )
        .limit(1),
    ),
  ).catch(() => [] as { pluginType: string }[]);
  return rows[0]?.pluginType ?? null;
}

// ── installPlugin ─────────────────────────────────────────────────────────────
//
// Matches the shape MarketplaceModal expects for installAction.
// workspaceId is forwarded by the modal but we resolve it server-side for security.

const InstallSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().optional(),
  /** workspaceId forwarded by MarketplaceModal — resolved server-side for security */
  workspaceId: z.string().optional(),
  catalogServerId: z.string().optional(),
  pluginId: z.string().optional(),
  pluginType: z
    .enum(["mcp_server", "integration", "content_tool", "capability"])
    .default("mcp_server"),
});

export async function installPlugin(
  input: z.infer<typeof InstallSchema>,
): Promise<{ ok: boolean; orgListingId?: string; error?: string }> {
  const parsed = InstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug } = parsed.data;
  const workspaceSlug = parsed.data.workspaceSlug ?? "";

  if (!workspaceSlug) return { ok: false, error: "workspaceSlug is required" };

  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  // Install at org level (plugins are org-scoped; workspaces opt in/out)
  const ctx = buildCtx({ orgId: org.id, workspaceId: ORG_ONLY_WS, userId: session.user.id });

  try {
    const out = await invoke(
      "plugin.org.install",
      {
        pluginType: parsed.data.pluginType,
        catalogServerId: parsed.data.catalogServerId,
        pluginId: parsed.data.pluginId,
      },
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(workspace.settings.plugins(routeCtx));

    // Enable at workspace scope if we got a listing id
    const typed = out as { orgListingId: string };
    if (typed.orgListingId) {
      const wsCtx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
      await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
        invoke(
          "plugin.workspace.set_enabled",
          { orgListingId: typed.orgListingId, enabled: true },
          wsCtx,
          { surface: "agent" },
        ),
      ).catch(() => {
        // Non-fatal: listing installed at org level but ws-enable failed
      });
    }
    return { ok: true, orgListingId: typed.orgListingId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Install failed" };
  }
}

// ── installBulkPlugin ─────────────────────────────────────────────────────────
//
// Matches the shape MarketplaceModal expects for installBulkAction.

const InstallBulkSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().optional(),
  workspaceId: z.string().optional(),
  items: z
    .array(
      z.object({
        catalogServerId: z.string().optional(),
        pluginType: z
          .enum(["mcp_server", "integration", "content_tool", "capability"])
          .default("mcp_server"),
        pluginId: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export async function installBulkPlugin(
  input: z.infer<typeof InstallBulkSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = InstallBulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug } = parsed.data;
  const workspaceSlug = parsed.data.workspaceSlug ?? "";

  if (!workspaceSlug) return { ok: false, error: "workspaceSlug is required" };

  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const ctx = buildCtx({ orgId: org.id, workspaceId: ORG_ONLY_WS, userId: session.user.id });

  try {
    const out = await invoke(
      "plugin.org.install_bulk",
      { items: parsed.data.items },
      ctx,
      { surface: "agent" },
    );

    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(workspace.settings.plugins(routeCtx));

    // Enable each newly-installed listing at workspace scope
    const typed = out as {
      installed: Array<{
        catalogServerId: string | null;
        orgListingId: string | null;
        error: string | null;
      }>;
    };
    const wsCtx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
      await Promise.all(
        typed.installed
          .filter((r) => r.orgListingId && !r.error)
          .map((r) =>
            invoke(
              "plugin.workspace.set_enabled",
              { orgListingId: r.orgListingId!, enabled: true },
              wsCtx,
              { surface: "agent" },
            ).catch(() => undefined),
          ),
      );
    }).catch(() => undefined);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Bulk install failed" };
  }
}

// ── togglePlugin ──────────────────────────────────────────────────────────────

const ToggleSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function togglePlugin(
  input: z.infer<typeof ToggleSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = ToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, enabled } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const pluginType = await getListingPluginType(org.id, orgListingId);

  try {
    if (pluginType === "capability") {
      // Capability packs are org-scoped (Phase 1) — toggle the org listing.
      // plugin.workspace.set_enabled throws for capability type.
      const orgCtx = buildCtx({ orgId: org.id, workspaceId: ORG_ONLY_WS, userId: session.user.id });
      await invoke("plugin.org.set_enabled", { orgListingId, enabled }, orgCtx, {
        surface: "agent",
      });
    } else {
      // Workspace-level plugins — toggle the per-workspace install row.
      const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
      await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
        invoke("plugin.workspace.set_enabled", { orgListingId, enabled }, ctx, {
          surface: "agent",
        }),
      );
    }
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(workspace.settings.plugins(routeCtx));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
  }
}

// ── uninstallPlugin ───────────────────────────────────────────────────────────
//
// Workspace-level uninstall = disable the listing for this workspace only.
// Org-level uninstall (remove from the org entirely) is available from the org
// settings/plugins page. Here we disable at workspace scope.
// TODO(OXA-???): add a plugin.workspace.uninstall contract for a true
// workspace-scoped remove.

const UninstallSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
});

export async function uninstallPlugin(
  input: z.infer<typeof UninstallSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = UninstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const pluginType = await getListingPluginType(org.id, orgListingId);

  try {
    if (pluginType === "capability") {
      // Capability packs are org-scoped — remove from the org allow-list
      // (soft-delete + drop dependent workspace installs). There is no
      // workspace-only disable path for capabilities in Phase 1.
      const orgCtx = buildCtx({ orgId: org.id, workspaceId: ORG_ONLY_WS, userId: session.user.id });
      await invoke("plugin.org.uninstall", { orgListingId }, orgCtx, { surface: "agent" });
    } else {
      // Workspace-level uninstall = disable the listing for this workspace only.
      const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
      await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
        invoke("plugin.workspace.set_enabled", { orgListingId, enabled: false }, ctx, {
          surface: "agent",
        }),
      );
    }
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(workspace.settings.plugins(routeCtx));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Uninstall failed" };
  }
}
