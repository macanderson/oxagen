import { db, schema } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import { CREDIT_REASONS } from "./constants.js";

const ALLOWED_REASONS = new Set<string>(Object.values(CREDIT_REASONS));

export interface GrantCreditsArgs {
  orgId: string;
  deltaCents: bigint;
  reason: string;
  referenceType?: string;
  referenceId?: string;
  createdByUserId?: string;
}

/**
 * Writes one ledger row and atomically bumps the balance. The transaction
 * boundary is the contract: a partial write that updates the ledger but
 * leaves the balance stale would silently corrupt billing. Postgres row-
 * level locking on credit_balances serializes concurrent writers.
 */
export async function grantCredits(args: GrantCreditsArgs): Promise<{ balanceCents: bigint }> {
  if (!ALLOWED_REASONS.has(args.reason)) {
    throw new Error(`invalid credit reason: ${args.reason}`);
  }
  const d = db();
  return await d.transaction(async (tx) => {
    await tx.insert(schema.creditLedger).values({
      orgId: args.orgId,
      deltaCents: args.deltaCents,
      reason: args.reason,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
      createdByUserId: args.createdByUserId ?? null,
    });

    // Upsert the balance: INSERT new row at zero+delta, or atomically add
    // to existing balance. ON CONFLICT requires the unique index on org_id.
    const updated = await tx
      .insert(schema.creditBalances)
      .values({
        orgId: args.orgId,
        balanceCents: args.deltaCents,
        lastEventAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.creditBalances.orgId,
        set: {
          balanceCents: sql`${schema.creditBalances.balanceCents} + ${args.deltaCents}`,
          lastEventAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ balanceCents: schema.creditBalances.balanceCents });

    const balance = updated[0]?.balanceCents ?? 0n;
    return { balanceCents: typeof balance === "bigint" ? balance : BigInt(balance) };
  });
}

export interface ConsumeCreditsArgs {
  orgId: string;
  /** Credits the caller wants to spend (positive). 1 credit = 1 cent. */
  requestedCents: bigint;
  reason: string;
  referenceType?: string;
  referenceId?: string;
}

export interface ConsumeCreditsResult {
  /** Credits actually debited (== requested unless the balance was short). */
  chargedCents: bigint;
  /** Requested − charged. Non-zero only when the balance was exhausted. */
  shortfallCents: bigint;
  /** Resulting balance. */
  balanceCents: bigint;
}

/**
 * Atomically debit up to `requestedCents` credits, never driving the balance
 * below zero (credit_balances enforces `balance_cents >= 0`). The balance row
 * is locked `FOR UPDATE` inside the transaction so concurrent consumers can't
 * race past the clamp — the read, the clamp, the ledger insert, and the balance
 * decrement are one atomic unit. Returns the amount actually charged and any
 * shortfall (the caller outran its credits).
 *
 * A zero or fully-clamped debit writes NO ledger row (the ledger CHECK forbids a
 * zero delta).
 */
export async function consumeCredits(args: ConsumeCreditsArgs): Promise<ConsumeCreditsResult> {
  if (!ALLOWED_REASONS.has(args.reason)) {
    throw new Error(`invalid credit reason: ${args.reason}`);
  }
  if (args.requestedCents <= 0n) {
    return { chargedCents: 0n, shortfallCents: 0n, balanceCents: 0n };
  }
  const d = db();
  return await d.transaction(async (tx) => {
    const locked = await tx
      .select({ balanceCents: schema.creditBalances.balanceCents })
      .from(schema.creditBalances)
      .where(eq(schema.creditBalances.orgId, args.orgId))
      .for("update");
    const balance = locked[0]?.balanceCents ?? 0n;
    const charge = args.requestedCents <= balance ? args.requestedCents : balance;
    const shortfall = args.requestedCents - charge;

    if (charge <= 0n) {
      return { chargedCents: 0n, shortfallCents: shortfall, balanceCents: balance };
    }

    await tx.insert(schema.creditLedger).values({
      orgId: args.orgId,
      deltaCents: -charge,
      reason: args.reason,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
    });
    const updated = await tx
      .update(schema.creditBalances)
      .set({
        balanceCents: sql`${schema.creditBalances.balanceCents} - ${charge}`,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.creditBalances.orgId, args.orgId))
      .returning({ balanceCents: schema.creditBalances.balanceCents });

    const newBalance = updated[0]?.balanceCents ?? balance - charge;
    return {
      chargedCents: charge,
      shortfallCents: shortfall,
      balanceCents: typeof newBalance === "bigint" ? newBalance : BigInt(newBalance),
    };
  });
}
