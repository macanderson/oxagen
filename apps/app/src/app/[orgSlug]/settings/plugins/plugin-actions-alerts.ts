"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

const CAN_MANAGE_PLUGINS = new Set(["owner", "admin"]);
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
const NOT_AUTHORIZED =
  "You don't have permission to manage plugins for this organization.";

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

// ── setAuthAlertsAction ───────────────────────────────────────────────────────

/**
 * Roles accepted by the plugin.settings.set_auth_alerts contract.
 * Must be title-case to match the capability's enum.
 */
const AuthAlertRole = z.enum(["Owner", "Admin", "Compliance", "Billing"]);

const AuthAlertsSchema = z.object({
  orgSlug: z.string().min(1),
  sendEmail: z.boolean(),
  roles: z.array(AuthAlertRole).min(1),
});

export async function setAuthAlertsAction(
  input: z.infer<typeof AuthAlertsSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = AuthAlertsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });

  try {
    await invoke(
      "plugin.settings.set_auth_alerts",
      {
        sendEmail: parsed.data.sendEmail,
        roles: parsed.data.roles,
      },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to update alert settings",
    };
  }
}
