import { withTenantDb, withSystemDb, schema, type Tx } from "@oxagen/database";
import { inTransaction } from "./internal/in-transaction";
import { and, asc, eq, isNull, or, sql, gt } from "drizzle-orm";
import { CREDIT_REASONS } from "./constants";
import { MICRO_CREDITS_PER_CREDIT } from "./pricing";

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
  createdById?: string;
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
        createdById: args.createdById ?? null,
        updatedById: args.createdById ?? null,
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
      createdById: args.createdById ?? null,
    });

    // 3. Collect any debt a mid-turn shortfall left, out of the credits that
    // just arrived. Before the mirror, so the settings-then-lots lock order
    // matches consumeCredits.
    const settled = await settleOwedCredits(tx, args.orgId);

    // 4. Mirror into credit_balances (cached derived value).
    // The mirror tracks grants and spends only — nothing decrements it when a
    // lot passes its expires_at, so it drifts ABOVE the real spendable balance
    // once any expiring lot lapses. Treat it as a display cache; every
    // gating decision must read {@link effectiveBalance}, which sums live lots.
    await upsertBalanceMirror(tx, args.orgId, args.amountCents - settled);

    // 5. Compute the new effective balance (lazy expiry — expired lots excluded).
    const now = new Date();
    const balanceRows = await tx
      .select({
        remaining: sql<string>`COALESCE(SUM(${schema.creditLots.remainingCents}), 0)`,
      })
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

    const effectiveBalanceCents = BigInt(balanceRows[0]?.remaining ?? "0");

    return { lotId, effectiveBalanceCents };
  });
}

/**
 * Add `deltaCents` to the credit_balances mirror, creating the row if the org
 * has none. A grant that also settled a debt can hand in a negative delta, so
 * the mirror is floored at zero like every other write to it.
 */
export async function upsertBalanceMirror(
  tx: Tx,
  orgId: string,
  deltaCents: bigint,
  at: Date = new Date(),
): Promise<void> {
  await tx
    .insert(schema.creditBalances)
    .values({
      orgId,
      balanceCents: deltaCents > 0n ? deltaCents : 0n,
      lastEventAt: at,
    })
    .onConflictDoUpdate({
      target: schema.creditBalances.orgId,
      set: {
        balanceCents: sql`GREATEST(${schema.creditBalances.balanceCents} + ${deltaCents}, 0)`,
        lastEventAt: at,
        updatedAt: at,
      },
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
  createdById?: string;
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
      createdById: args.createdById,
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
      .select({
        remaining: sql<string>`COALESCE(SUM(${schema.creditLots.remainingCents}), 0)`,
      })
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

  return BigInt(rows[0]?.remaining ?? "0");
}

// ---------------------------------------------------------------------------
// Consume credits — soonest-expiring-first, no overdraft
// ---------------------------------------------------------------------------

interface ConsumeCreditsBase {
  orgId: string;
  reason: string;
  referenceType?: string;
  referenceId?: string;
  /**
   * The person the spend is attributed to, written to
   * `credit_ledger.created_by_id` (a uuid column). Only a caller that knows
   * who acted passes it: the in-app agent's turn names the person who asked.
   * Left off, the row names nobody, which is true of a background spend.
   */
  createdById?: string;
}

/**
 * What to spend, in one of two units — a caller gives exactly one.
 *
 * `requestedCents` is a spend the caller already knows in whole credits: a
 * grant reversal, a manual adjustment. It is debited as given.
 *
 * `requestedMicroCents` is a spend that can be a FRACTION of a credit, which is
 * every metered model call. The fraction is banked against the org and only
 * whole credits are debited, so a sequence of sub-credit calls costs exactly
 * what it should. Rounding each one up instead charged a 200-token embedding
 * 739x its cost (#1413), and the platform makes one such call per ingested
 * entity.
 */
export type ConsumeCreditsArgs = ConsumeCreditsBase &
  (
    | {
        requestedCents: bigint;
        requestedMicroCents?: never;
        carryShortfall?: never;
      }
    | {
        requestedMicroCents: bigint;
        requestedCents?: never;
        /**
         * Keep what the balance could not cover as a debt, rather than drop
         * it. The whole credits left unpaid are banked in this reason's carry
         * bucket beside the sub-credit fraction, so the next charge under the
         * same reason and the next grant ({@link settleOwedCredits}) collect
         * them, and the turn credit gate reads them as owed
         * ({@link owedCredits}). The metering chokepoint sets it for
         * `consume_assistant_tokens` alone: that is the line whose shortfall
         * was a platform-key cost nobody paid.
         */
        carryShortfall?: boolean;
      }
  );

export interface ConsumeCreditsResult {
  /** Credits actually debited (== requested unless the balance was short). */
  chargedCents: bigint;
  /** Requested − charged. Non-zero only when the balance was exhausted. */
  shortfallCents: bigint;
  /** Resulting effective balance. */
  balanceCents: bigint;
  /**
   * Sub-credit remainder left banked against the org FOR THIS CALL'S `reason`
   * after this call, in micro-credits — always in [0, 1e6). Other reasons keep
   * their own buckets and are neither read nor reported here. Zero for a
   * `requestedCents` caller, which does not carry.
   *
   * Same caveat as `balanceCents`: a non-positive request short-circuits before
   * opening a transaction, so this reads 0 without the stored carry having been
   * looked at. Meaningful only when the request was positive.
   */
  carryMicroCents: bigint;
  /**
   * Whole credits this reason owed from earlier calls when this one began: the
   * debt a `carryShortfall` caller left in the bucket. Part of the request this
   * call made, so `requested - priorOwedCents` is what this call alone came to.
   */
  priorOwedCents: bigint;
  /**
   * Whole credits this reason still owes after this call: `shortfallCents` for
   * a `carryShortfall` caller, zero for every other caller, whose shortfall is
   * dropped.
   */
  owedCents: bigint;
}

/** One non-expired lot with credit left, as the debit paths lock it. */
interface SpendableLot {
  id: string;
  remainingCents: bigint | string;
}

const asBigint = (value: bigint | string): bigint =>
  typeof value === "bigint" ? value : BigInt(value);

/**
 * Lock the org's spendable lots, soonest-expiring first (expires_at NULLS
 * LAST, so non-expiring lots are spent last). Both debit paths take the
 * settings row before this, which is the lock order that keeps a grant and a
 * charge from deadlocking.
 */
async function lockSpendableLots(
  tx: Tx,
  orgId: string,
  now: Date,
): Promise<SpendableLot[]> {
  return tx
    .select({
      id: schema.creditLots.id,
      remainingCents: schema.creditLots.remainingCents,
      expiresAt: schema.creditLots.expiresAt,
    })
    .from(schema.creditLots)
    .where(
      and(
        eq(schema.creditLots.orgId, orgId),
        or(
          isNull(schema.creditLots.expiresAt),
          gt(schema.creditLots.expiresAt, now),
        ),
        gt(schema.creditLots.remainingCents, 0n),
      ),
    )
    .orderBy(asc(schema.creditLots.expiresAt))
    .for("update");
}

/**
 * Take `amount` out of `lots` in order, never driving one below zero. The
 * caller has already clamped `amount` to what the lots hold. Mutates the
 * in-memory `remainingCents` so a second draw in the same transaction sees
 * what the first left.
 */
async function drainLots(
  tx: Tx,
  lots: SpendableLot[],
  amount: bigint,
): Promise<void> {
  let remaining = amount;
  for (const lot of lots) {
    if (remaining <= 0n) break;
    const lotRemaining = asBigint(lot.remainingCents);
    if (lotRemaining <= 0n) continue;
    const debit = remaining <= lotRemaining ? remaining : lotRemaining;
    remaining -= debit;
    lot.remainingCents = lotRemaining - debit;
    await tx
      .update(schema.creditLots)
      .set({
        remainingCents: sql`${schema.creditLots.remainingCents} - ${debit}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.creditLots.id, lot.id));
  }
}

/**
 * A carry bucket as the JSON column stores it. The fraction alone is always
 * under 1e6; a bucket that also holds a debt is larger, and must stay an exact
 * JSON number. 2^53 micro-credits is about 9 billion credits of debt, which
 * the turn credit gate makes unreachable, so passing it is a defect to stop
 * on rather than a value to round.
 */
function bucketValue(microCredits: bigint): number {
  const value = Number(microCredits);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `meter carry bucket out of range: ${microCredits.toString()} micro-credits`,
    );
  }
  return value;
}

/**
 * Atomically debit the requested spend from the org's lots, drawing from
 * soonest-expiring lots first (expires_at NULLS LAST). Never drives any lot's
 * remaining_cents below zero. Returns the amount actually charged and any
 * shortfall.
 *
 * A `requestedMicroCents` caller is debited only the whole credits its running
 * total has reached; the sub-credit remainder is banked on the org's settings
 * row inside this same transaction, so a crash cannot charge a fraction twice
 * or lose it. The carry is banked PER `reason`, so a fraction accrued under one
 * billing reason can never be debited under another — the reasons are priced
 * differently (assistant tokens at exactly cost, everything else at the solved
 * markup), so a pooled carry would bill one line's margin against another and
 * count it against that line's cap.
 *
 * What the lots cannot cover is never debited. A `carryShortfall` caller
 * banks it in the same bucket as a debt, which the next charge under the
 * reason and the next grant collect ({@link settleOwedCredits}); every other
 * caller's shortfall is dropped.
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
  transaction?: Tx,
): Promise<ConsumeCreditsResult> {
  if (!ALLOWED_REASONS.has(args.reason)) {
    throw new Error(`invalid credit reason: ${args.reason}`);
  }
  const micro = args.requestedMicroCents;
  const nothingToSpend =
    micro === undefined ? (args.requestedCents ?? 0n) <= 0n : micro <= 0n;
  if (nothingToSpend) {
    return {
      chargedCents: 0n,
      shortfallCents: 0n,
      balanceCents: 0n,
      carryMicroCents: 0n,
      priorOwedCents: 0n,
      owedCents: 0n,
    };
  }

  const run = async (tx: Tx): Promise<ConsumeCreditsResult> => {
    const now = new Date();

    // Resolve the sub-credit carry BEFORE touching the lots, so the whole-credit
    // figure below is what the org actually owes across its call history under
    // THIS reason rather than this call rounded up on its own. Ordering also
    // fixes the lock order (settings, then lots) for the one path that takes
    // both.
    //
    // The read and the write-back are two statements in one transaction, and the
    // upsert is what makes that safe: ON CONFLICT DO UPDATE takes the row lock
    // and its RETURNING sees the latest committed version, so a concurrent
    // charge for the same org blocks here and reads the post-write map rather
    // than racing it. The lock is then held for the rest of the transaction, so
    // writing the whole map back cannot clobber another charge's bucket.
    //
    // Only this reason's bucket is touched. Pooling every reason in one counter
    // was exact in total and wrong in attribution: a 0.9-credit marked-up
    // embedding followed by a 0.1-credit assistant turn crossed the boundary on
    // the assistant's call and wrote a whole credit as
    // `consume_assistant_tokens`, putting embedding margin on a line that bills
    // at exactly cost and counting it against the assistant spend cap.
    //
    // A bucket can also hold whole credits: the debt a `carryShortfall` caller
    // left when the balance ran out. They are part of `requested` here, so this
    // call collects them first, before its own cost.
    let requested = args.requestedCents ?? 0n;
    let carryMicroCents = 0n;
    let priorOwedCents = 0n;
    let writeBack: ((owedCents: bigint) => Promise<void>) | null = null;
    if (micro !== undefined) {
      const locked = await tx
        .insert(schema.orgBillingSettings)
        .values({ orgId: args.orgId })
        .onConflictDoUpdate({
          target: schema.orgBillingSettings.orgId,
          set: { updatedAt: now },
        })
        .returning({
          carryByReason:
            schema.orgBillingSettings.meterCarryMicroCreditsByReason,
        });

      const carryByReason = locked[0]?.carryByReason ?? {};
      const banked = BigInt(carryByReason[args.reason] ?? 0);
      priorOwedCents = banked / MICRO_CREDITS_PER_CREDIT;
      const total = banked + micro;
      requested = total / MICRO_CREDITS_PER_CREDIT;
      carryMicroCents = total % MICRO_CREDITS_PER_CREDIT;
      const fraction = carryMicroCents;

      writeBack = (owedCents: bigint) =>
        tx
          .update(schema.orgBillingSettings)
          .set({
            meterCarryMicroCreditsByReason: {
              ...carryByReason,
              [args.reason]: bucketValue(
                owedCents * MICRO_CREDITS_PER_CREDIT + fraction,
              ),
            },
            updatedAt: now,
          })
          .where(eq(schema.orgBillingSettings.orgId, args.orgId))
          .then(() => undefined);

      // Still under a whole credit even with everything banked before it —
      // nothing to debit yet, and nothing lost: it stays in the carry.
      if (requested <= 0n) {
        await writeBack(0n);
        return {
          chargedCents: 0n,
          shortfallCents: 0n,
          balanceCents: 0n,
          carryMicroCents,
          priorOwedCents,
          owedCents: 0n,
        };
      }
    }

    const lots = await lockSpendableLots(tx, args.orgId, now);

    // Compute how much we can charge across all lots.
    const totalAvailable = lots.reduce(
      (acc, l) => acc + asBigint(l.remainingCents),
      0n,
    );
    const charge = requested <= totalAvailable ? requested : totalAvailable;
    // credit_balances forbids an overdraft, so what the lots cannot cover is
    // never debited here. A `carryShortfall` caller keeps it as a debt in its
    // bucket; every other caller's shortfall is dropped, as before.
    const shortfall = requested - charge;
    const owedCents =
      micro !== undefined && args.carryShortfall === true ? shortfall : 0n;
    if (writeBack) await writeBack(owedCents);

    if (charge <= 0n) {
      return {
        chargedCents: 0n,
        shortfallCents: shortfall,
        balanceCents: totalAvailable,
        carryMicroCents,
        priorOwedCents,
        owedCents,
      };
    }

    await drainLots(tx, lots, charge);

    // Write the ledger entries. The debt an earlier call left is collected
    // first and gets its own row, attributed to nobody: the bucket does not
    // record who ran it up, and naming this call's person would put another
    // person's spend on their statement.
    const debtPaid = charge < priorOwedCents ? charge : priorOwedCents;
    if (debtPaid > 0n) {
      await tx.insert(schema.creditLedger).values({
        orgId: args.orgId,
        deltaCents: -debtPaid,
        reason: args.reason,
        referenceType: "credit_debt",
        referenceId: null,
        createdById: null,
      });
    }
    const ownCharge = charge - debtPaid;
    if (ownCharge > 0n) {
      await tx.insert(schema.creditLedger).values({
        orgId: args.orgId,
        deltaCents: -ownCharge,
        reason: args.reason,
        referenceType: args.referenceType ?? null,
        referenceId: args.referenceId ?? null,
        createdById: args.createdById ?? null,
      });
    }

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
      carryMicroCents,
      priorOwedCents,
      owedCents,
    };
  };
  return inTransaction(transaction, run);
}

// ---------------------------------------------------------------------------
// Owed credits — the debt a carryShortfall charge left, and its settlement
// ---------------------------------------------------------------------------

/** Whole credits owed across every reason's carry bucket. */
function owedInBuckets(carryByReason: Record<string, number>): bigint {
  let owed = 0n;
  for (const micro of Object.values(carryByReason)) {
    owed += BigInt(micro) / MICRO_CREDITS_PER_CREDIT;
  }
  return owed;
}

/**
 * Whole credits the org owes and has not paid: the debt a `carryShortfall`
 * charge banked when the balance ran out mid-turn. The sub-credit fractions
 * beside it are not counted; they are not owed as a credit until they add up
 * to one.
 *
 * The turn credit gate reads balance minus this, so an org that outran its
 * credits is not admitted again until a grant has covered what it owes.
 * Reads through withTenantDb (the caller is inside a tenant scope), or
 * withSystemDb with `opts.system` for a cross-tenant sweep.
 */
export async function owedCredits(
  orgId: string,
  opts?: { system?: boolean },
): Promise<bigint> {
  const runner = opts?.system ? withSystemDb : withTenantDb;
  const rows = await runner((tx) =>
    tx
      .select({
        carryByReason: schema.orgBillingSettings.meterCarryMicroCreditsByReason,
      })
      .from(schema.orgBillingSettings)
      .where(eq(schema.orgBillingSettings.orgId, orgId))
      .limit(1),
  );
  return owedInBuckets(rows[0]?.carryByReason ?? {});
}

/**
 * Collect what the org owes out of the lots it holds, on the grant's own
 * transaction, and return the credits collected so the caller can take them
 * off the credit_balances mirror it is about to write.
 *
 * Call it after the grant's lot is inserted and before the mirror is touched.
 * It locks the settings row and then the lots, the same order consumeCredits
 * takes them, so a grant and a concurrent charge queue rather than deadlock.
 * Each reason's debt is written to the ledger under that reason, so a
 * settled assistant debt is a `consume_assistant_tokens` debit like any
 * other, and the assistant spend cap counts it. The collection is clamped to
 * the lots, so a grant smaller than the debt pays part of it and the rest
 * stays owed. Nothing here can overdraw a lot.
 *
 * An org with no settings row, or no whole credit in any bucket, reads one row
 * and writes nothing.
 */
export async function settleOwedCredits(
  tx: Tx,
  orgId: string,
): Promise<bigint> {
  const rows = await tx
    .select({
      carryByReason: schema.orgBillingSettings.meterCarryMicroCreditsByReason,
    })
    .from(schema.orgBillingSettings)
    .where(eq(schema.orgBillingSettings.orgId, orgId))
    .for("update");
  const carryByReason = rows[0]?.carryByReason ?? {};
  if (owedInBuckets(carryByReason) <= 0n) return 0n;

  const now = new Date();
  const lots = await lockSpendableLots(tx, orgId, now);
  let available = lots.reduce((acc, l) => acc + asBigint(l.remainingCents), 0n);
  const next: Record<string, number> = { ...carryByReason };
  let collected = 0n;
  // Sorted so two settlements of the same map write their rows in one order.
  for (const reason of Object.keys(carryByReason).sort()) {
    if (available <= 0n) break;
    const banked = BigInt(carryByReason[reason] ?? 0);
    const owed = banked / MICRO_CREDITS_PER_CREDIT;
    if (owed <= 0n) continue;
    const pay = owed <= available ? owed : available;
    await drainLots(tx, lots, pay);
    await tx.insert(schema.creditLedger).values({
      orgId,
      deltaCents: -pay,
      reason,
      referenceType: "credit_debt",
      referenceId: null,
      createdById: null,
    });
    next[reason] = bucketValue(banked - pay * MICRO_CREDITS_PER_CREDIT);
    available -= pay;
    collected += pay;
  }
  if (collected <= 0n) return 0n;
  await tx
    .update(schema.orgBillingSettings)
    .set({ meterCarryMicroCreditsByReason: next, updatedAt: now })
    .where(eq(schema.orgBillingSettings.orgId, orgId));
  return collected;
}
