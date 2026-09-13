"use server";

/**
 * Server actions for the Policies page (MCP auth-alert setting).
 *
 * Security surface: apps/app does not bootstrap kernel IAM, so the write is
 * explicitly gated to org admins (assertOrgAdmin) before invoke() — deny is
 * the default; nothing fails open. The set_auth_alerts capability itself is
 * audited by the kernel invoke envelope.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { logger } from "@oxagen/handlers/logger";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgAdmin } from "@/lib/resolve-org";
import { org as orgRoutes } from "@/lib/routes";
import { invokeOrgCapability } from "../_lib/invoke-org";

const saveSchema = z.object({
  orgSlug: z.string().min(1),
  sendEmail: z.boolean(),
  roles: z.array(z.enum(["Owner", "Admin", "Compliance", "Billing"])).min(1),
});

export interface SaveAuthAlertsResult {
  ok: boolean;
  error?: string;
}

export async function saveAuthAlertsAction(input: {
  orgSlug: string;
  sendEmail: boolean;
  roles: string[];
}): Promise<SaveAuthAlertsResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Select at least one role — someone must receive MCP auth alerts.",
    };
  }
  const { orgSlug, sendEmail, roles } = parsed.data;

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Not authenticated." };

  const tenant = await resolveOrg(orgSlug);
  try {
    await assertOrgAdmin(tenant.id, userId);
  } catch {
    return {
      ok: false,
      error: "Only org owners and admins can change alert settings.",
    };
  }

  try {
    await invokeOrgCapability<{ ok: boolean }>(
      tenant.id,
      userId,
      "set_auth_alerts",
      {
        sendEmail,
        roles,
      },
    );
  } catch (err) {
    logger.error(
      { err, orgId: tenant.id },
      "governance/policies: set_auth_alerts failed",
    );
    return { ok: false, error: "Saving the alert setting failed. Try again." };
  }

  revalidatePath(orgRoutes.governance.policies({ orgSlug }));
  return { ok: true };
}
