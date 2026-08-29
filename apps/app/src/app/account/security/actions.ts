"use server";
/**
 * actions.ts — server actions for the account/security page.
 *
 * revokeOwnSessionAction: lets a user revoke one of their own sessions.
 * No org gate — users can always revoke their own sessions.
 * The current session is excluded at the page level (no self-revoke of the
 * active tab). The action still guards against revoking sessions that don't
 * belong to the authenticated user.
 *
 * Emits: security.session_revoked
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { getSessionOrRedirect } from "@/lib/session";
import { logger } from "@oxagen/handlers/logger";

// Sentinel workspaceId for user-scoped actions.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const RevokeOwnSessionSchema = z.object({
  sessionId: z.string().min(1),
});

export type RevokeOwnSessionInput = z.infer<typeof RevokeOwnSessionSchema>;

export type RevokeOwnSessionResult =
  | { ok: true }
  | { ok: false; code: "validation_error"; error: string }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "self_session" }
  | { ok: false; code: "internal"; error: string };

export async function revokeOwnSessionAction(
  input: RevokeOwnSessionInput,
): Promise<RevokeOwnSessionResult> {
  const session = await getSessionOrRedirect();

  const parsed = RevokeOwnSessionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "validation_error",
      error: "Invalid input",
    };
  }

  const { sessionId } = parsed.data;

  // Guard against revoking the current session via this route.
  // (The page marks the current session as un-revokable, but this is the
  // server-side enforcement.)
  const currentSessionId = session.session?.id;
  if (currentSessionId && sessionId === currentSessionId) {
    return { ok: false, code: "self_session" };
  }

  // Scope the delete to the authenticated user — prevents revoking someone
  // else's session even if they know the session id.
  let deleted: { id: string }[];
  try {
    deleted = await withSystemDb((tx) =>
      tx
        .delete(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, session.user.id),
          ),
        )
        .returning({ id: schema.sessions.id }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ sessionId, err: msg }, "revokeOwnSessionAction: db error");
    return { ok: false, code: "internal", error: "Failed to revoke session" };
  }

  if (deleted.length === 0) {
    return { ok: false, code: "not_found" };
  }

  // Emit audit event. orgId is a sentinel because user-scoped actions have no
  // org scope — sessions span orgs. We use the user's primary org if available;
  // otherwise use an empty sentinel. The audit record is still useful for
  // forensics (actorUserId + sessionId/requestId are populated).
  emitSecurityEvent({
    eventType: "security.session_revoked",
    actorUserId: session.user.id,
    orgId: "00000000-0000-0000-0000-000000000000",
    workspaceId: ORG_ONLY_WS,
    capability: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: sessionId,
  });

  revalidatePath("/account/security");
  return { ok: true };
}
