import { db, schema } from "@oxagen/database";
import { sql } from "drizzle-orm";

const ALLOWED_REASONS = new Set([
  "grant_signup",
  "grant_plan_renewal",
  "grant_manual",
  "consume_execution",
  "consume_tool_call",
  "consume_token_overage",
  "refund",
  "adjustment",
]);

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
