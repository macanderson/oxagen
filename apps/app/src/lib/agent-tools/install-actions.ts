"use server";
/**
 * install-actions.ts — the single install choke point for agent tools.
 *
 * Workspace-scoped plugin management: install from marketplace, toggle enabled
 * state, uninstall, and manage registries. All operations delegate to workspace-
 * scoped contracts (plugin.org.*, plugin.workspace.*, plugin.registry.*,
 * skill.workspace.install). Every UI install path — Marketplace browse, the
 * marketplace modal, the Agent Builder's Equip step, MCP connect — calls
 * through this module, and authorization is decided exclusively by
 * resolveAgentToolsManager (see ./authz.ts for the future-RBAC seam).
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveAgentToolsManager } from "./authz";

// ── Helpers ───────────────────────────────────────────────────────────────────

function capabilitiesPath(ctx: Required<ScopeContext>): string {
  return workspace.workbench.tools.capabilities(ctx);
}

// ── installPlugin ─────────────────────────────────────────────────────────────

const InstallSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().optional(),
  workspaceId: z.string().optional(),
  catalogServerId: z.string().optional(),
  pluginId: z.string().optional(),
  pluginType: z
    .enum([
      "mcp_server",
      "integration",
      "content_tool",
      "capability",
      "agent_skill",
      "agent_capability",
      "knowledge_source",
    ])
    .default("mcp_server"),
});

export async function installPlugin(
  input: z.infer<typeof InstallSchema>,
): Promise<{
  ok: boolean;
  orgListingId?: string;
  /** "oauth" → the server needs the OAuth authorize flow before it works. */
  authKind?: "oauth" | "secret" | "none";
  error?: string;
}> {
  const parsed = InstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug } = parsed.data;
  const workspaceSlug = parsed.data.workspaceSlug ?? "";

  if (!workspaceSlug) return { ok: false, error: "workspaceSlug is required" };

  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

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
      await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
        // install_skill (skill.workspace.install) is exposed on ["api","mcp"]
        // only — passing { surface: "agent" } throws surface_denied. Omit it.
        invoke("install_skill", { slug, workspace_id: ws.id }, ctx),
      );
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(capabilitiesPath(routeCtx));
      return { ok: true };
    } else if (pluginType === "agent_capability") {
      installInput = {
        pluginType,
        pluginId: parsed.data.pluginId ?? parsed.data.catalogServerId,
      };
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
    const out = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () => invoke("install_plugin", installInput, ctx, { surface: "agent" }),
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(capabilitiesPath(routeCtx));
    revalidatePath(workspace.workbench.tools.mcp(routeCtx));

    const typed = out as {
      orgListingId: string;
      authKind?: "oauth" | "secret" | "none";
    };
    return {
      ok: true,
      orgListingId: typed.orgListingId,
      authKind: typed.authKind,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Install failed",
    };
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
          .enum([
            "mcp_server",
            "integration",
            "content_tool",
            "capability",
            "agent_skill",
            "agent_capability",
            "knowledge_source",
          ])
          .default("mcp_server"),
        pluginId: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export async function installBulkPlugin(
  input: z.infer<typeof InstallBulkSchema>,
): Promise<{ ok: boolean; error?: string; failures?: string[] }> {
  const parsed = InstallBulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug } = parsed.data;
  const workspaceSlug = parsed.data.workspaceSlug ?? "";

  if (!workspaceSlug) return { ok: false, error: "workspaceSlug is required" };

  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

  try {
    // The marketplace sends each selected row as { catalogServerId, pluginType }
    // only. plugin.org.install_bulk → installOne expects the SAME per-type shape
    // the single-install action builds: agent_capability needs `pluginId`;
    // mcp_server / integration / knowledge_source need `custom` (endpoint resolved
    // from the workspace registries by name); agent_skill installs through a
    // different contract entirely. Normalise here, mirroring installPlugin — the
    // raw rows would make installOne reject every item.
    const items = parsed.data.items;
    const failures: string[] = [];
    let attempted = 0;

    // agent_skill rows install a workspace-owned copy of the builtin template
    // via skill.workspace.install — never plugin.org.install_bulk.
    const skillItems = items.filter((i) => i.pluginType === "agent_skill");
    for (const it of skillItems) {
      attempted += 1;
      const slug = it.catalogServerId ?? it.pluginId;
      if (!slug) {
        failures.push("skill slug is required");
        continue;
      }
      try {
        await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
          // install_skill (skill.workspace.install) is exposed on ["api","mcp"]
          // only — passing { surface: "agent" } throws surface_denied. Omit it.
          invoke("install_skill", { slug, workspace_id: ws.id }, ctx),
        );
      } catch (e) {
        failures.push(e instanceof Error ? e.message : "skill install failed");
      }
    }

    // Map the remaining rows to the plugin.org.install_bulk input shape.
    const bulkItems = items
      .filter((i) => i.pluginType !== "agent_skill")
      .map((it) => {
        const rowId = it.pluginId ?? it.catalogServerId;
        const pluginType =
          it.pluginType === "capability" ? "agent_capability" : it.pluginType;
        if (pluginType === "agent_capability") {
          return { pluginType, pluginId: rowId };
        }
        // mcp_server / integration / knowledge_source: pass the row id as the
        // custom server name with an empty endpoint so installOne resolves the
        // real endpoint from the workspace's enabled registries.
        return {
          pluginType,
          ...(rowId
            ? {
                custom: {
                  name: rowId,
                  endpointUrl: "",
                  transport: "streamable-http",
                  authKind: "none" as const,
                },
              }
            : {}),
        };
      });

    if (bulkItems.length > 0) {
      attempted += bulkItems.length;
      const result = (await runInTenantScope(
        { orgId: org.id, workspaceId: ws.id },
        () =>
          invoke("install_plugins_bulk", { items: bulkItems }, ctx, {
            surface: "agent",
          }),
      )) as {
        installed: Array<{
          pluginId: string | null;
          orgListingId: string | null;
          error: string | null;
        }>;
      };

      // The handler always returns HTTP 200; partial failures are embedded in the
      // installed[] array rather than thrown.
      failures.push(
        ...result.installed
          .filter((r) => r.error !== null)
          .map((r) => r.error as string),
      );
    }

    if (failures.length > 0) {
      return {
        ok: false,
        error: `${failures.length} of ${attempted} plugin(s) failed to install`,
        failures,
      };
    }

    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(capabilitiesPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Bulk install failed",
    };
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
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

  try {
    await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
      invoke(
        "set_plugin_enabled",
        { scope: "workspace", orgListingId, enabled },
        ctx,
        { surface: "agent" },
      ),
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(capabilitiesPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Update failed",
    };
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
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

  try {
    await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
      invoke("uninstall_plugin", { orgListingId }, ctx, { surface: "agent" }),
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(capabilitiesPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Uninstall failed",
    };
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
): Promise<{
  ok: boolean;
  registryId?: string;
  isDefault?: boolean;
  error?: string;
}> {
  const parsed = AddRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  try {
    const out = await invoke(
      "add_plugin_registry",
      { name: parsed.data.name, baseUrl: parsed.data.baseUrl },
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(capabilitiesPath(routeCtx));
    const typed = out as { registryId: string; isDefault: boolean };
    return {
      ok: true,
      registryId: typed.registryId,
      isDefault: typed.isDefault,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Registry add failed",
    };
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
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  try {
    const out = await invoke(
      "remove_plugin_registry",
      { registryId: parsed.data.registryId },
      ctx,
      { surface: "agent" },
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(capabilitiesPath(routeCtx));
    const typed = out as { ok: boolean; promotedId: string | null };
    return { ok: true, promotedId: typed.promotedId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Registry remove failed",
    };
  }
}
