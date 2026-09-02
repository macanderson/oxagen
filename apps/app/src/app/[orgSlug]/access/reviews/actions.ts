"use server";
/**
 * actions.ts — server actions for the access review screen.
 *
 * confirmMemberAccessAction: record that the reviewer has confirmed a member's
 *   access is still appropriate. Emits access.member_access_confirmed.
 *
 * revokeMemberAccessAction: remove the member from the org entirely.
 *   Emits access.review_completed and org.member_removed.
 *   Gate: owner/admin only (assertSecurityManager).
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  assertSecurityManager,
  assertOrgMember,
} from "@/lib/resolve-org";
import { isAuthDenialError } from "@/lib/auth-denial";
import { logger } from "@oxagen/handlers/logger";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const ConfirmMemberSchema = z.object({
  orgSlug: z.string().min(1),
  targetUserId: z.string().uuid(),
});

const RevokeMemberSchema = z.object({
  orgSlug: z.string().min(1),
  targetUserId: z.string().uuid(),
});

export type ReviewActionResult =
  | { ok: true }
  | { ok: false; code: "forbidden" }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "self_action" }
  | { ok: false; code: "validation_error"; error: string }
  | { ok: false; code: "internal"; error: string };

/** Confirm a member's access is still appropriate (read-all gate). */
export async function confirmMemberAccessAction(
  input: z.infer<typeof ConfirmMemberSchema>,
): Promise<ReviewActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = ConfirmMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "validation_error", error: "Invalid input" };
  }
  const { orgSlug, targetUserId } = parsed.data;

  let orgId: string;
  try {
    const tenant = await resolveOrg(orgSlug);
    orgId = tenant.id;
    // Any org member can confirm (read-level review).
    await assertOrgMember(orgId, session.user.id);
  } catch (err) {
    if (isAuthDenialError(err)) {
      return { ok: false, code: "forbidden" };
    }
    logger.error(
      { orgSlug, err: String(err) },
      "confirm-member: auth gate failed unexpectedly",
    );
    return { ok: false, code: "internal", error: "Failed to verify access" };
  }

  emitSecurityEvent({
    eventType: "access.member_access_confirmed",
    actorUserId: session.user.id,
    orgId,
    workspaceId: ORG_ONLY_WS,
    capability: targetUserId,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });

  revalidatePath(`/${orgSlug}/access/reviews`);
  return { ok: true };
}

/** Revoke a member's org access (owner/admin gate). */
export async function revokeMemberAccessAction(
  input: z.infer<typeof RevokeMemberSchema>,
): Promise<ReviewActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = RevokeMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "validation_error", error: "Invalid input" };
  }
  const { orgSlug, targetUserId } = parsed.data;

  // Disallow self-revocation via this route.
  if (targetUserId === session.user.id) {
    return { ok: false, code: "self_action" };
  }

  let orgId: string;
  try {
    const tenant = await resolveOrg(orgSlug);
    orgId = tenant.id;
    await assertSecurityManager(orgId, session.user.id);
  } catch (err) {
    if (isAuthDenialError(err)) {
      return { ok: false, code: "forbidden" };
    }
    logger.error(
      { orgSlug, err: String(err) },
      "revoke-member: auth gate failed unexpectedly",
    );
    return { ok: false, code: "internal", error: "Failed to verify access" };
  }

  const deleted = await withSystemDb((tx) =>
    tx
      .delete(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, orgId),
          eq(schema.orgUsers.userId, targetUserId),
        ),
      )
      .returning({ id: schema.orgUsers.id }),
  );

  if (deleted.length === 0) {
    return { ok: false, code: "not_found" };
  }

  emitSecurityEvent({
    eventType: "org.member_removed",
    actorUserId: session.user.id,
    orgId,
    workspaceId: ORG_ONLY_WS,
    capability: targetUserId,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });

  emitSecurityEvent({
    eventType: "access.review_completed",
    actorUserId: session.user.id,
    orgId,
    workspaceId: ORG_ONLY_WS,
    capability: targetUserId,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });

  revalidatePath(`/${orgSlug}/access/reviews`);
  revalidatePath(`/${orgSlug}/members`);
  return { ok: true };
}
