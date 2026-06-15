"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import { isUniqueViolation, withSystemDb, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";

// ── Constants ─────────────────────────────────────────────────────────────────

const CAN_MANAGE_PLUGINS = new Set(["owner", "admin"]);
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
const NOT_AUTHORIZED =
  "You don't have permission to manage plugins for this organization.";

// ── resolveManagedOrgForPlugins ───────────────────────────────────────────────

/**
 * Authorization gate for every mutating org plugin action.
 *
 * Resolves the org AND asserts the caller (a) is a member of that org and
 * (b) holds an MCP-management role (owner/admin). Returns `{ orgId, actorUserId }`
 * on success, or `null` when the caller lacks rights.
 */
async function resolveManagedOrgForPlugins(
  orgSlug: string,
): Promise<{ orgId: string; actorUserId: string } | null> {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);
  if (!session.user) return null;

  const { withTenantDb, schema } = await import("@oxagen/database");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await runInTenantScope(
    { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, tenant.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );
  const role = row?.role ?? null;
  if (!role || !CAN_MANAGE_PLUGINS.has(role)) {
    logger.warn(
      { orgSlug, userId: session.user.id, role },
      "plugin: action denied — not a plugin manager",
    );
    return null;
  }
  return { orgId: tenant.id, actorUserId: session.user.id };
}

// ── buildCtx ─────────────────────────────────────────────────────────────────

function buildCtx(opts: { orgId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: "",
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

// ── installPluginAction ───────────────────────────────────────────────────────

const InstallSchema = z.object({
  orgSlug: z.string().min(1),
  /** Workspace context — accepted but not used at the org-settings layer */
  workspaceId: z.string().optional(),
  catalogServerId: z.string().optional(),
  /** Required when pluginType === "capability" — the stable plugin id (e.g. "oxagen/media-svg") */
  pluginId: z.string().optional(),
  pluginType: z
    .enum(["mcp_server", "integration", "content_tool", "capability"])
    .default("mcp_server"),
  custom: z
    .object({
      name: z.string().min(1).max(120),
      title: z.string().max(120).optional(),
      description: z.string().max(500).optional(),
      endpointUrl: z.string().url(),
      transport: z.string().min(1),
      authKind: z.enum(["oauth", "secret", "none"]),
    })
    .optional(),
});

export async function installPluginAction(
  input: z.infer<typeof InstallSchema>,
): Promise<{ ok: boolean; orgListingId?: string; error?: string }> {
  const parsed = InstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke(
      "plugin.org.install",
      {
        pluginType: parsed.data.pluginType,
        catalogServerId: parsed.data.catalogServerId,
        pluginId: parsed.data.pluginId,
        custom: parsed.data.custom,
      },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    const typed = out as { orgListingId: string };
    return { ok: true, orgListingId: typed.orgListingId };
  } catch (err) {
    // Idempotent install: if the listing already exists (unique constraint
    // on org_id + plugin_type + name), look it up and return it as success.
    // This handles the case where a listing was pre-seeded or previously installed.
    const lookupName = parsed.data.pluginType === "capability"
      ? parsed.data.pluginId
      : parsed.data.catalogServerId;
    if (isUniqueViolation(err) && lookupName) {
      try {
        const nameColumn = parsed.data.pluginType === "capability"
          ? schema.pluginOrgListings.name
          : schema.pluginOrgListings.catalogServerId;
        const [existing] = await withSystemDb((tx) =>
          tx
            .select({ id: schema.pluginOrgListings.id })
            .from(schema.pluginOrgListings)
            .where(
              and(
                eq(schema.pluginOrgListings.orgId, managed.orgId),
                eq(schema.pluginOrgListings.pluginType, parsed.data.pluginType),
                eq(nameColumn, lookupName),
              ),
            )
            .limit(1),
        );
        if (existing) {
          revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
          logger.info(
            { orgListingId: existing.id, orgId: managed.orgId },
            "installPluginAction: listing already exists — returning existing id",
          );
          return { ok: true, orgListingId: existing.id };
        }
      } catch (lookupErr) {
        logger.error({ lookupErr }, "installPluginAction: lookup after conflict failed");
      }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Install failed",
    };
  }
}

// ── installBulkPluginAction ───────────────────────────────────────────────────

const InstallBulkSchema = z.object({
  orgSlug: z.string().min(1),
  /** Workspace context — accepted but not used at the org-settings layer */
  workspaceId: z.string().optional(),
  items: z
    .array(
      z.object({
        catalogServerId: z.string().optional(),
        /** Required when pluginType === "capability" */
        pluginId: z.string().optional(),
        pluginType: z
          .enum(["mcp_server", "integration", "content_tool", "capability"])
          .default("mcp_server"),
      }),
    )
    .min(1)
    .max(50),
});

export async function installBulkPluginAction(
  input: z.infer<typeof InstallBulkSchema>,
): Promise<{
  ok: boolean;
  installed?: Array<{
    catalogServerId: string | null;
    orgListingId: string | null;
    error: string | null;
  }>;
  error?: string;
}> {
  const parsed = InstallBulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke(
      "plugin.org.install_bulk",
      { items: parsed.data.items },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    const typed = out as {
      installed: Array<{
        catalogServerId: string | null;
        orgListingId: string | null;
        error: string | null;
      }>;
    };
    return { ok: true, installed: typed.installed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Bulk install failed",
    };
  }
}

// ── setOrgPluginEnabledAction ─────────────────────────────────────────────────

const SetEnabledSchema = z.object({
  orgSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function setOrgPluginEnabledAction(
  input: z.infer<typeof SetEnabledSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = SetEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke(
      "plugin.org.set_enabled",
      {
        orgListingId: parsed.data.orgListingId,
        enabled: parsed.data.enabled,
      },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Update failed",
    };
  }
}

// ── uninstallPluginAction ─────────────────────────────────────────────────────

const UninstallSchema = z.object({
  orgSlug: z.string().min(1),
  orgListingId: z.string().min(1),
});

export async function uninstallPluginAction(
  input: z.infer<typeof UninstallSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = UninstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke(
      "plugin.org.uninstall",
      { orgListingId: parsed.data.orgListingId },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Uninstall failed",
    };
  }
}

// ── addDenylistAction ─────────────────────────────────────────────────────────

const DenylistAddSchema = z.object({
  orgSlug: z.string().min(1),
  serverName: z.string().min(1),
  pluginType: z
    .enum(["mcp_server", "integration", "content_tool", "capability"])
    .default("mcp_server"),
  reason: z.string().max(500).optional(),
});

export async function addDenylistAction(
  input: z.infer<typeof DenylistAddSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = DenylistAddSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke(
      "plugin.denylist.add",
      {
        serverName: parsed.data.serverName,
        pluginType: parsed.data.pluginType,
        reason: parsed.data.reason,
      },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Denylist add failed",
    };
  }
}

// ── removeDenylistAction ──────────────────────────────────────────────────────

const DenylistRemoveSchema = z.object({
  orgSlug: z.string().min(1),
  serverName: z.string().min(1),
  pluginType: z
    .enum(["mcp_server", "integration", "content_tool", "capability"])
    .default("mcp_server"),
});

export async function removeDenylistAction(
  input: z.infer<typeof DenylistRemoveSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = DenylistRemoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke(
      "plugin.denylist.remove",
      {
        serverName: parsed.data.serverName,
        pluginType: parsed.data.pluginType,
      },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Denylist remove failed",
    };
  }
}

// ── addRegistryAction ─────────────────────────────────────────────────────────

const AddRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
});

export async function addRegistryAction(
  input: z.infer<typeof AddRegistrySchema>,
): Promise<{ ok: boolean; registryId?: string; error?: string }> {
  const parsed = AddRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke(
      "plugin.registry.add",
      { name: parsed.data.name, baseUrl: parsed.data.baseUrl },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    const typed = out as { registryId: string };
    return { ok: true, registryId: typed.registryId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Registry add failed",
    };
  }
}

// ── removeRegistryAction ──────────────────────────────────────────────────────

const RemoveRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  registryId: z.string().min(1),
});

export async function removeRegistryAction(
  input: z.infer<typeof RemoveRegistrySchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = RemoveRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke(
      "plugin.registry.remove",
      { registryId: parsed.data.registryId },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Registry remove failed",
    };
  }
}
