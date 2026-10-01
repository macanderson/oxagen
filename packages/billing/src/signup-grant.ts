/**
 * signup-grant.ts — the one-time signup grant of governed actions (ADR-NEW,
 * amending ADR-055; Mac's decision of 2026-10-01, #4886).
 *
 * A new organisation receives one grant, sized and timed by the Free plan
 * row (`signup_grant_gau`, `signup_grant_days`). It is never renewed. Once it
 * is spent or expired, the organisation subscribes to keep governing, unless
 * an operator has cleared `subscription_required_after_grant` on that row.
 *
 * `issueSignupGrant` is the one writer and runs on the caller's transaction:
 * `create_org`'s bootstrap transaction, so an organisation never exists
 * without its grant. The unique index on `gau_signup_grants.org_id` makes it
 * once-only: a second call inserts nothing and returns null.
 */

import { eq } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import { FREE_PLAN_SLUG } from "./contract-terms";

const DAY_MS = 86_400_000;

/** An organisation's signup grant, as stored. */
export interface SignupGrant {
  grantedGau: number;
  grantedAt: Date;
  expiresAt: Date;
}

/** The Free row's grant figures, read when a grant is issued. */
export interface SignupGrantPolicy {
  grantGau: number;
  grantDays: number;
}

/**
 * The grant a signup at `now` receives under `policy`: the size as it
 * stands, and an expiry `grantDays` days later.
 */
export function signupGrantFor(
  policy: SignupGrantPolicy,
  now: Date,
): SignupGrant {
  return {
    grantedGau: Math.max(0, Math.floor(policy.grantGau)),
    grantedAt: now,
    expiresAt: new Date(now.getTime() + policy.grantDays * DAY_MS),
  };
}

/** Whether the grant's window holds `now`. */
export function signupGrantActive(grant: SignupGrant, now: Date): boolean {
  return now < grant.expiresAt;
}

/** The Free row's grant figures, on the caller's executor. */
export async function readSignupGrantPolicy(
  tx: Tx,
): Promise<SignupGrantPolicy> {
  const rows = await tx
    .select({
      grantGau: schema.plans.signupGrantGau,
      grantDays: schema.plans.signupGrantDays,
    })
    .from(schema.plans)
    .where(eq(schema.plans.slug, FREE_PLAN_SLUG))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // The Free plan is written by `pnpm db:migrate` (seedPlatform). Granting
    // a guessed size would hand out a figure nobody set.
    throw new Error(
      "billing: no signup grant terms — the Free plan row is not seeded",
    );
  }
  return { grantGau: Number(row.grantGau), grantDays: Number(row.grantDays) };
}

/**
 * Issue the organisation's signup grant, once. Reads the Free row's figures
 * on the same transaction, so the grant is the one in force at the moment of
 * signup. Returns the grant it wrote, or null when the organisation already
 * had one: the unique index on `org_id` refuses a second.
 */
export async function issueSignupGrant(
  tx: Tx,
  orgId: string,
  now: Date = new Date(),
): Promise<SignupGrant | null> {
  const grant = signupGrantFor(await readSignupGrantPolicy(tx), now);
  const rows = await tx
    .insert(schema.gauSignupGrants)
    .values({ orgId, ...grant })
    .onConflictDoNothing({ target: schema.gauSignupGrants.orgId })
    .returning({
      grantedGau: schema.gauSignupGrants.grantedGau,
      grantedAt: schema.gauSignupGrants.grantedAt,
      expiresAt: schema.gauSignupGrants.expiresAt,
    });
  const row = rows[0];
  return row ? { ...row, grantedGau: Number(row.grantedGau) } : null;
}
