"use server";
/**
 * actions.ts — server actions for the MFA org policy screen.
 *
 * saveMfaPolicyAction: upsert security.org_security_policy for the org.
 * Gate: owner or admin only (assertSecurityManager).
 * Emits: security.mfa_policy_updated on every successful save.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertSecurityManager } from "@/lib/resolve-org";
import { isAuthDenialError } from "@/lib/auth-denial";
import { logger } from "@oxagen/handlers/logger";

// Sentinel workspaceId for org-only actions.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const SaveMfaPolicySchema = z.object({
  orgSlug: z.string().min(1),
  mfaRequired: z.boolean(),
  mfaGraceHours: z.number().int().min(0).max(720),
});

export type SaveMfaPolicyInput = z.infer<typeof SaveMfaPolicySchema>;

export type SaveMfaPolicyResult =
  | { ok: true }
  | { ok: false; code: "forbidden" }
  | { ok: false; code: "validation_error"; error: string }
  | { ok: false; code: "internal"; error: string };

export async function saveMfaPolicyAction(
  input: SaveMfaPolicyInput,
): Promise<SaveMfaPolicyResult> {
  const session = await getSessionOrRedirect();

  const parsed = SaveMfaPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "validation_error", error: "Invalid input" };
  }

  const { orgSlug, mfaRequired, mfaGraceHours } = parsed.data;

  let orgId: string;
  try {
    const tenant = await resolveOrg(orgSlug);
    orgId = tenant.id;
    // Enforces owner|admin — calls notFound() if not permitted.
    await assertSecurityManager(orgId, session.user.id);
  } catch (err) {
    // Only a genuine authorization denial (notFound sentinel) maps to
    // forbidden. A DB/infra failure here must surface as internal (and be
    // logged) — otherwise a degraded Postgres looks like a permission error
    // to the admin, who stops retrying, and the outage is invisible.
    if (isAuthDenialError(err)) {
      return { ok: false, code: "forbidden" };
    }
    logger.error(
      { orgSlug, err: String(err) },
      "mfa-policy: auth gate failed unexpectedly",
    );
    return { ok: false, code: "internal", error: "Failed to verify access" };
  }

  try {
    const now = new Date();
    // Upsert — insert or update on conflict with org_id primary key.
    await withSystemDb((tx) =>
      tx
        .insert(schema.orgSecurityPolicy)
        .values({
          orgId,
          mfaRequired,
          mfaGraceHours,
          updatedByUserId: session.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.orgSecurityPolicy.orgId,
          set: {
            mfaRequired,
            mfaGraceHours,
            updatedByUserId: session.user.id,
            updatedAt: now,
          },
        }),
    );

    emitSecurityEvent({
      eventType: "security.mfa_policy_updated",
      actorUserId: session.user.id,
      orgId,
      workspaceId: ORG_ONLY_WS,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });

    revalidatePath(`/${orgSlug}/security/mfa`);
    revalidatePath(`/${orgSlug}/security`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { orgSlug, err: msg },
      "mfa-policy: saveMfaPolicyAction failed",
    );
    return { ok: false, code: "internal", error: "Failed to save MFA policy" };
  }
}

/** The org MFA policy, plus the timestamp the enforcement grace window anchors on. */
export interface MfaPolicy {
  mfaRequired: boolean;
  mfaGraceHours: number;
  /** When the policy row was last written — the grace-window anchor. */
  updatedAt: Date;
}

/**
 * loadMfaPolicy — read the org's security policy row.
 * Returns null when no policy has been saved yet (defaults apply: mfaRequired=false).
 */
export async function loadMfaPolicy(orgId: string): Promise<MfaPolicy | null> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        mfaRequired: schema.orgSecurityPolicy.mfaRequired,
        mfaGraceHours: schema.orgSecurityPolicy.mfaGraceHours,
        updatedAt: schema.orgSecurityPolicy.updatedAt,
      })
      .from(schema.orgSecurityPolicy)
      .where(eq(schema.orgSecurityPolicy.orgId, orgId))
      .limit(1),
  );
  const row = rows[0];
  return row
    ? {
        mfaRequired: row.mfaRequired,
        mfaGraceHours: row.mfaGraceHours,
        updatedAt: row.updatedAt,
      }
    : null;
}
