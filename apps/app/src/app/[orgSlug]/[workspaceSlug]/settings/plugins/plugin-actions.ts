"use server";
/**
 * plugin-actions.ts — server actions for Workspace → Settings → Plugins.
 *
 * Workspace-scoped plugin management: install from marketplace, toggle enabled
 * state, uninstall, and manage registries. All operations delegate to workspace-
 * scoped contracts (plugin.registry.*, plugin.workspace.*).
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { eq, and } from "drizzle-orm";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOT_AUTHORIZED = "Only workspace owners and admins can manage plugins.";

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

function pluginsPath(ctx: Required<ScopeContext>): string {
  return workspace.settings.plugins(ctx);
}

// ── installPlugin ─────────────────────────────────────────────────────────────

const InstallSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().optional(),
  workspaceId: z.string().optional(),
  catalogServerId: z.string().optional(),
  pluginId: z.string().optional(),
  pluginType: z
    .enum(["mcp_server", "integration", "content_tool", "capability", "agent_skill", "agent_capability", "knowledge_source"])
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

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    // Map browse-row fields to plugin.org.install input.
    // For mcp_server/integration: pass custom endpoint details (no catalogServerId).
    // For agent_capability: pass pluginId.
    // For agent_skill: install the builtin template into the workspace.
    // For knowledge_source: installed by default, nothing to install.
    const pluginType = parsed.data.pluginType;
    let installInput: {
      pluginType: typeof pluginType;
      pluginId?: string;
      custom?: {
        name: string;
        endpointUrl: string;
        transport: string;
        authKind: "oauth" | "secret" | "none";
      };
    };
    if (pluginType === "agent_skill") {
      // agent_skill entries install a workspace-owned copy of the builtin
      // template (idempotent on slug). The browse-row id carries the slug.
      const slug = parsed.data.catalogServerId ?? parsed.data.pluginId;
      if (!slug) return { ok: false, error: "skill slug is required" };
      await invoke(
        "skill.workspace.install",
        { slug, workspace_id: ws.id },
        ctx,
        { surface: "agent" },
      );
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(pluginsPath(routeCtx));
      return { ok: true };
    } else if (pluginType === "agent_capability") {
      installInput = { pluginType, pluginId: parsed.data.pluginId ?? parsed.data.catalogServerId };
    } else {
      // mcp_server, integration, knowledge_source: catalogServerId is the registry name.
      installInput = { pluginType };
      if (parsed.data.catalogServerId) {
        installInput.custom = {
          name: parsed.data.catalogServerId,
          endpointUrl: "",
          transport: "streamable-http",
          authKind: "none",
        };
      }
    }
    const out = await invoke(
      "plugin.org.install",
      installInput,
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(pluginsPath(routeCtx));

    const typed = out as { orgListingId: string };
    return { ok: true, orgListingId: typed.orgListingId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Install failed" };
  }
}

// ── installBulkPlugin ─────────────────────────────────────────────────────────

const InstallBulkSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().optional(),
  workspaceId: z.string().optional(),
  items: z
    .array(
      z.object({
        catalogServerId: z.string().optional(),
        pluginType: z
          .enum(["mcp_server", "integration", "content_tool", "capability", "agent_skill", "agent_capability", "knowledge_source"])
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

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    await invoke(
      "plugin.org.install_bulk",
      { items: parsed.data.items },
      ctx,
      { surface: "agent" },
    );

    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(pluginsPath(routeCtx));
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

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
      invoke("plugin.workspace.set_enabled", { orgListingId, enabled }, ctx, {
        surface: "agent",
      }),
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(pluginsPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
  }
}

// ── uninstallPlugin ───────────────────────────────────────────────────────────

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

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
      invoke("plugin.org.uninstall", { orgListingId }, ctx, { surface: "agent" }),
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(pluginsPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Uninstall failed" };
  }
}

// ── addRegistry ───────────────────────────────────────────────────────────────

const AddRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
});

export async function addRegistry(
  input: z.infer<typeof AddRegistrySchema>,
): Promise<{ ok: boolean; registryId?: string; isDefault?: boolean; error?: string }> {
  const parsed = AddRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    const out = await invoke(
      "plugin.registry.add",
      { name: parsed.data.name, baseUrl: parsed.data.baseUrl },
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(pluginsPath(routeCtx));
    const typed = out as { registryId: string; isDefault: boolean };
    return { ok: true, registryId: typed.registryId, isDefault: typed.isDefault };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Registry add failed" };
  }
}

// ── removeRegistry ────────────────────────────────────────────────────────────

const RemoveRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  registryId: z.string().min(1),
});

export async function removeRegistry(
  input: z.infer<typeof RemoveRegistrySchema>,
): Promise<{ ok: boolean; promotedId?: string | null; error?: string }> {
  const parsed = RemoveRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { canManage, org, ws, session } = await resolveAndAuthWorkspace(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: NOT_AUTHORIZED };

  const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });

  try {
    const out = await invoke(
      "plugin.registry.remove",
      { registryId: parsed.data.registryId },
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(pluginsPath(routeCtx));
    const typed = out as { ok: boolean; promotedId: string | null };
    return { ok: true, promotedId: typed.promotedId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Registry remove failed" };
  }
}
