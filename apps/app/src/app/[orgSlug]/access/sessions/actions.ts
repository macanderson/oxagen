"use server";
/**
 * actions.ts — server actions for the org session manager screen.
 *
 * revokeSessionAction: delete a session row (Better Auth session revoke).
 * Gate: owner or admin only (assertSecurityManager).
 * Emits: security.session_revoked.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertSecurityManager } from "@/lib/resolve-org";
import { isAuthDenialError } from "@/lib/auth-denial";
import { logger } from "@oxagen/handlers/logger";

// Sentinel workspaceId for org-only actions.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const RevokeSessionSchema = z.object({
  orgSlug: z.string().min(1),
  /** auth.sessions.id (text PK — Better Auth convention). */
  sessionId: z.string().min(1),
  /** The userId the session belongs to — used to scope the delete. */
  targetUserId: z.string().uuid(),
});

export type RevokeSessionInput = z.infer<typeof RevokeSessionSchema>;

export type RevokeSessionResult =
  | { ok: true }
  | { ok: false; code: "forbidden" }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "validation_error"; error: string }
  | { ok: false; code: "internal"; error: string };

export async function revokeSessionAction(
  input: RevokeSessionInput,
): Promise<RevokeSessionResult> {
  const session = await getSessionOrRedirect();

  const parsed = RevokeSessionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "validation_error", error: "Invalid input" };
  }

  const { orgSlug, sessionId, targetUserId } = parsed.data;

  let orgId: string;
  try {
    const tenant = await resolveOrg(orgSlug);
    orgId = tenant.id;
    await assertSecurityManager(orgId, session.user.id);
  } catch (err) {
    // Distinguish a real authorization denial (notFound sentinel) from a
    // DB/infra failure — the latter must surface as internal (and be logged),
    // not be silently misclassified as forbidden.
    if (isAuthDenialError(err)) {
      return { ok: false, code: "forbidden" };
    }
    logger.error(
      { orgSlug, err: String(err) },
      "revoke-session: auth gate failed unexpectedly",
    );
    return { ok: false, code: "internal", error: "Failed to verify access" };
  }

  // Verify target user is a member of this org before revoking.
  const memberRows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.orgUsers.id })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, orgId),
          eq(schema.orgUsers.userId, targetUserId),
        ),
      )
      .limit(1),
  );
  if (memberRows.length === 0) {
    return { ok: false, code: "not_found" };
  }

  // Delete the session row.
  const deleted = await withSystemDb((tx) =>
    tx
      .delete(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          eq(schema.sessions.userId, targetUserId),
        ),
      )
      .returning({ id: schema.sessions.id }),
  );

  if (deleted.length === 0) {
    return { ok: false, code: "not_found" };
  }

  emitSecurityEvent({
    eventType: "security.session_revoked",
    actorUserId: session.user.id,
    orgId,
    workspaceId: ORG_ONLY_WS,
    capability: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: sessionId,
  });

  revalidatePath(`/${orgSlug}/access/sessions`);
  return { ok: true };
}
