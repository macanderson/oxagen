import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { and, asc, eq, isNull, or, sql, gt } from "drizzle-orm";
import { CREDIT_REASONS } from "./constants";

const ALLOWED_REASONS = new Set<string>(Object.values(CREDIT_REASONS));

// ---------------------------------------------------------------------------
// Grant: create a credit lot
// ---------------------------------------------------------------------------

export interface CreateCreditLotArgs {
  orgId: string;
  /** Amount in credits (1 credit = 1 cent). */
  amountCents: bigint;
  /** Source of the lot. */
  source: "free_grant" | "subscription" | "purchase";
  /** Expiry date. NULL means the lot never expires. */
  expiresAt: Date | null;
  /** Ledger reason tag (must be in ALLOWED_REASONS). */
  reason: string;
  referenceType?: string;
  referenceId?: string;
  createdByUserId?: string;
}

export interface CreateCreditLotResult {
  lotId: string;
  /** New effective balance (sum of all non-expired remaining_cents). */
  effectiveBalanceCents: bigint;
}

/**
 * Create a credit lot and a matching credit_ledger row in one transaction.
 * Also upserts credit_balances, the cached balance table other reads use
 * instead of summing every lot.
 *
 * Invariants:
 *  - amountCents must be > 0
 *  - reason must be in ALLOWED_REASONS
 *  - source must be one of the three allowed values
 */
export async function createCreditLot(
  args: CreateCreditLotArgs,
): Promise<CreateCreditLotResult> {
  if (!ALLOWED_REASONS.has(args.reason)) {
    throw new Error(`invalid credit reason: ${args.reason}`);
  }
  if (args.amountCents <= 0n) {
    throw new Error("amountCents must be greater than zero");
  }

  return await withTenantDb(async (tx) => {
    // 1. Insert the lot.
    const [lot] = await tx
      .insert(schema.creditLots)
      .values({
        orgId: args.orgId,
        source: args.source,
        originalCents: args.amountCents,
        remainingCents: args.amountCents,
        grantedAt: new Date(),
        expiresAt: args.expiresAt ?? null,
        createdByUserId: args.createdByUserId ?? null,
        updatedByUserId: args.createdByUserId ?? null,
      })
      .returning({ id: schema.creditLots.id });

    const lotId = lot?.id;
    if (!lotId) throw new Error("credit lot insert returned no row");

    // 2. Append a ledger row.
    await tx.insert(schema.creditLedger).values({
      orgId: args.orgId,
      deltaCents: args.amountCents,
      reason: args.reason,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
      createdByUserId: args.createdByUserId ?? null,
    });

    // 3. Mirror into credit_balances (cached derived value).
    // The mirror tracks grants and spends only — nothing decrements it when a
    // lot passes its expires_at, so it drifts ABOVE the real spendable balance
    // once any expiring lot lapses. Treat it as a display cache; every
    // gating decision must read {@link effectiveBalance}, which sums live lots.
    await tx
      .insert(schema.creditBalances)
      .values({
        orgId: args.orgId,
        balanceCents: args.amountCents,
        lastEventAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.creditBalances.orgId,
        set: {
          balanceCents: sql`${schema.creditBalances.balanceCents} + ${args.amountCents}`,
          lastEventAt: new Date(),
          updatedAt: new Date(),
        },
      });

    // 4. Compute the new effective balance (lazy expiry — expired lots excluded).
    const now = new Date();
    const balanceRows = await tx
      .select({ remaining: schema.creditLots.remainingCents })
      .from(schema.creditLots)
      .where(
        and(
          eq(schema.creditLots.orgId, args.orgId),
          or(
            isNull(schema.creditLots.expiresAt),
            gt(schema.creditLots.expiresAt, now),
          ),
        ),
      );

    const effectiveBalanceCents = balanceRows.reduce(
      (acc, r) =>
        acc +
        (typeof r.remaining === "bigint" ? r.remaining : BigInt(r.remaining)),
      0n,
    );

    return { lotId, effectiveBalanceCents };
  });
}

// ---------------------------------------------------------------------------
// Legacy grantCredits shim — preserved so callers compile without changes.
// Internally creates a lot with source='free_grant' and no expiry.
// ---------------------------------------------------------------------------

export interface GrantCreditsArgs {
  orgId: string;
  deltaCents: bigint;
  reason: string;
  referenceType?: string;
  referenceId?: string;
  createdByUserId?: string;
}

/**
 * @deprecated Prefer `createCreditLot` which carries source and expiry.
 * This shim is kept for backward compatibility: positive deltas create a
 * free_grant lot; negative deltas (consumption) call consumeCredits internally.
 */
export async function grantCredits(
  args: GrantCreditsArgs,
): Promise<{ balanceCents: bigint }> {
  if (!ALLOWED_REASONS.has(args.reason)) {
    throw new Error(`invalid credit reason: ${args.reason}`);
  }

  if (args.deltaCents > 0n) {
    const { effectiveBalanceCents } = await createCreditLot({
      orgId: args.orgId,
      amountCents: args.deltaCents,
      source: "free_grant",
      expiresAt: null,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      createdByUserId: args.createdByUserId,
    });
    return { balanceCents: effectiveBalanceCents };
  }

  // Negative delta = consumption — delegate to consumeCredits.
  if (args.deltaCents < 0n) {
    const { balanceCents } = await consumeCredits({
      orgId: args.orgId,
      requestedCents: -args.deltaCents,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
    });
    return { balanceCents };
  }

  // Zero delta — no-op, just return current effective balance.
  return { balanceCents: await effectiveBalance(args.orgId) };
}

// ---------------------------------------------------------------------------
// Effective balance — lazy expiry, sum of non-expired lots
// ---------------------------------------------------------------------------

/**
 * Returns the org's effective credit balance: SUM(remaining_cents) for lots
 * that are not yet expired. Lazy expiry — expired lots are excluded from the
 * sum without being deleted.
 *
 * `opts.system` routes the read through {@link withSystemDb} instead of
 * {@link withTenantDb}. Request paths always run inside a tenant scope and must
 * leave this false so RLS stays load-bearing; only trusted cross-tenant crons
 * that sweep every org with no active scope (e.g. billing.dunning-sweep) pass
 * `system: true`, mirroring sweepDunning()'s own withSystemDb usage.
 */
export async function effectiveBalance(
  orgId: string,
  opts?: { system?: boolean },
): Promise<bigint> {
  const now = new Date();
  const runner = opts?.system ? withSystemDb : withTenantDb;
  const rows = await runner((tx) =>
    tx
      .select({ remaining: schema.creditLots.remainingCents })
      .from(schema.creditLots)
      .where(
        and(
          eq(schema.creditLots.orgId, orgId),
          or(
            isNull(schema.creditLots.expiresAt),
            gt(schema.creditLots.expiresAt, now),
          ),
        ),
      ),
  );

  return rows.reduce(
    (acc, r) =>
      acc +
      (typeof r.remaining === "bigint" ? r.remaining : BigInt(r.remaining)),
    0n,
  );
}

// ---------------------------------------------------------------------------
// Consume credits — soonest-expiring-first, no overdraft
// ---------------------------------------------------------------------------

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
  /** Resulting effective balance. */
  balanceCents: bigint;
}

/**
 * Atomically debit up to `requestedCents` credits from the org's lots, drawing
 * from soonest-expiring lots first (expires_at NULLS LAST). Never drives any
 * lot's remaining_cents below zero. Returns the amount actually charged and any
 * shortfall.
 *
 * A zero or fully-clamped debit writes NO ledger row (the ledger CHECK forbids
 * a zero delta). credit_balances is decremented in the same transaction to keep
 * the cached mirror consistent.
 *
 * Caveat on the returned `balanceCents`: for a non-positive `requestedCents`
 * this returns 0 WITHOUT reading the DB — the call short-circuits before opening
 * a transaction. Treat `balanceCents` as meaningful only when `requestedCents`
 * was positive; use {@link effectiveBalance} when you actually need the balance.
 */
export async function consumeCredits(
  args: ConsumeCreditsArgs,
): Promise<ConsumeCreditsResult> {
  if (!ALLOWED_REASONS.has(args.reason)) {
    throw new Error(`invalid credit reason: ${args.reason}`);
  }
  if (args.requestedCents <= 0n) {
    return { chargedCents: 0n, shortfallCents: 0n, balanceCents: 0n };
  }

  return await withTenantDb(async (tx) => {
    const now = new Date();

    // Lock and read all non-expired lots for this org, soonest-expiring first.
    // expires_at NULLS LAST → non-expiring (free) lots are consumed last.
    const lots = await tx
      .select({
        id: schema.creditLots.id,
        remainingCents: schema.creditLots.remainingCents,
        expiresAt: schema.creditLots.expiresAt,
      })
      .from(schema.creditLots)
      .where(
        and(
          eq(schema.creditLots.orgId, args.orgId),
          or(
            isNull(schema.creditLots.expiresAt),
            gt(schema.creditLots.expiresAt, now),
          ),
          gt(schema.creditLots.remainingCents, 0n),
        ),
      )
      .orderBy(asc(schema.creditLots.expiresAt))
      .for("update");

    // Compute how much we can charge across all lots.
    const totalAvailable = lots.reduce(
      (acc, l) =>
        acc +
        (typeof l.remainingCents === "bigint"
          ? l.remainingCents
          : BigInt(l.remainingCents)),
      0n,
    );
    const charge =
      args.requestedCents <= totalAvailable
        ? args.requestedCents
        : totalAvailable;
    const shortfall = args.requestedCents - charge;

    if (charge <= 0n) {
      return {
        chargedCents: 0n,
        shortfallCents: shortfall,
        balanceCents: totalAvailable,
      };
    }

    // Drain lots in order, decrementing remaining_cents.
    let remaining = charge;
    for (const lot of lots) {
      if (remaining <= 0n) break;
      const lotRemaining =
        typeof lot.remainingCents === "bigint"
          ? lot.remainingCents
          : BigInt(lot.remainingCents);
      const debit = remaining <= lotRemaining ? remaining : lotRemaining;
      remaining -= debit;
      await tx
        .update(schema.creditLots)
        .set({
          remainingCents: sql`${schema.creditLots.remainingCents} - ${debit}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.creditLots.id, lot.id));
    }

    // Write the ledger entry.
    await tx.insert(schema.creditLedger).values({
      orgId: args.orgId,
      deltaCents: -charge,
      reason: args.reason,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
    });

    // Keep the credit_balances mirror in sync. This is an UPDATE, so it is a
    // silent no-op for an org that has no mirror row yet; the lots above are
    // still debited correctly, since they are the authoritative balance.
    await tx
      .update(schema.creditBalances)
      .set({
        balanceCents: sql`GREATEST(${schema.creditBalances.balanceCents} - ${charge}, 0)`,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(eq(schema.creditBalances.orgId, args.orgId));

    const newBalance = totalAvailable - charge;
    return {
      chargedCents: charge,
      shortfallCents: shortfall,
      balanceCents: newBalance,
    };
  });
}
