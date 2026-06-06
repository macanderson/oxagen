/**
 * seats.ts — seat / license model for Oxagen.
 *
 * Rules:
 *   - one org = one plan; subscription quantity = seat count = license count.
 *   - qty 1 = 1 license; free/no-sub orgs have exactly 1 license.
 *   - pending invitations consume a seat (the invited user is reserved until
 *     they decline or the invite expires).
 *   - `assertSeatAvailable` must be called BEFORE creating an invitation.
 */

import { and, count, eq, sql } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { logger } from "./logger";

// ── SeatLimitError ────────────────────────────────────────────────────────────

/**
 * Thrown when an org has no available licenses.
 *
 * The machine-readable `code` lets callers (API route, MCP tool) map this
 * to an appropriate response without string-matching the message.
 */
export class SeatLimitError extends Error {
  readonly code = "seat_limit_reached" as const;
  readonly licenses: number;
  readonly used: number;

  constructor(licenses: number, used: number) {
    super(
      `Seat limit reached: org is using ${used} of ${licenses} available license(s). Upgrade your plan or remove a member to continue.`,
    );
    this.name = "SeatLimitError";
    this.licenses = licenses;
    this.used = used;
  }
}

/** Type guard — true when `err` is a SeatLimitError. */
export function isSeatLimitError(err: unknown): err is SeatLimitError {
  return err instanceof SeatLimitError;
}

// ── SeatUsage ─────────────────────────────────────────────────────────────────

export interface OrgSeatUsage {
  /** Total licenses for this org (from active subscription seatCount, or 1 for free). */
  licenses: number;
  /** Currently consumed: active org_users + pending invitations. */
  used: number;
  /** licenses - used. May be 0 when the org is at the limit. */
  available: number;
}

// ── getOrgSeatUsage ───────────────────────────────────────────────────────────

/**
 * Return the current seat usage for an org.
 *
 * - `licenses`: from the active subscription's `seat_count`, defaulting to 1
 *   when there is no active subscription (free tier always gets 1 seat).
 * - `used`: active org_users + pending invitations.
 * - `available`: licenses minus used (clamped at 0).
 *
 * Pure DB read — no Stripe calls, safe to call on every request.
 */
export async function getOrgSeatUsage(orgId: string): Promise<OrgSeatUsage> {
  const { activeSub, usersRow, invRow } = await withTenantDb(async (tx) => {
    const sub = await tx
      .select({ seatCount: schema.subscriptions.seatCount })
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.orgId, orgId),
          sql`${schema.subscriptions.status} IN ('active','trialing')`,
        ),
      )
      .limit(1);

    const [uRow] = await tx
      .select({ total: count() })
      .from(schema.orgUsers)
      .where(eq(schema.orgUsers.orgId, orgId));

    const [iRow] = await tx
      .select({ total: count() })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, orgId),
          eq(schema.invitations.status, "pending"),
        ),
      );

    return { activeSub: sub, usersRow: uRow, invRow: iRow };
  });

  const licenses = activeSub[0]?.seatCount ?? 1;
  const activeUsers = Number(usersRow?.total ?? 0);
  const pendingInvitations = Number(invRow?.total ?? 0);

  const used = activeUsers + pendingInvitations;
  const available = Math.max(0, licenses - used);

  logger.debug(
    { orgId, licenses, activeUsers, pendingInvitations, used, available },
    "billing: org seat usage resolved",
  );

  return { licenses, used, available };
}

// ── assertSeatAvailable ───────────────────────────────────────────────────────

/**
 * Assert that the org has at least one available license.
 *
 * Throws `SeatLimitError` when `used >= licenses`. Callers should invoke this
 * before creating an invitation or adding a member directly.
 */
export async function assertSeatAvailable(orgId: string): Promise<void> {
  const usage = await getOrgSeatUsage(orgId);
  if (usage.used >= usage.licenses) {
    logger.warn(
      { orgId, licenses: usage.licenses, used: usage.used },
      "billing: seat limit reached",
    );
    throw new SeatLimitError(usage.licenses, usage.used);
  }
}
