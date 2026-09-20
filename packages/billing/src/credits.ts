import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
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
    | { requestedCents: bigint; requestedMicroCents?: never }
    | { requestedMicroCents: bigint; requestedCents?: never }
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
  const micro = args.requestedMicroCents;
  const nothingToSpend =
    micro === undefined ? (args.requestedCents ?? 0n) <= 0n : micro <= 0n;
  if (nothingToSpend) {
    return {
      chargedCents: 0n,
      shortfallCents: 0n,
      balanceCents: 0n,
      carryMicroCents: 0n,
    };
  }

  return await withTenantDb(async (tx) => {
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
    let requested = args.requestedCents ?? 0n;
    let carryMicroCents = 0n;
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
      const total = banked + micro;
      requested = total / MICRO_CREDITS_PER_CREDIT;
      carryMicroCents = total % MICRO_CREDITS_PER_CREDIT;

      await tx
        .update(schema.orgBillingSettings)
        .set({
          meterCarryMicroCreditsByReason: {
            ...carryByReason,
            // Always < 1e6 by construction, so exact as a JSON number.
            [args.reason]: Number(carryMicroCents),
          },
          updatedAt: now,
        })
        .where(eq(schema.orgBillingSettings.orgId, args.orgId));

      // Still under a whole credit even with everything banked before it —
      // nothing to debit yet, and nothing lost: it stays in the carry.
      if (requested <= 0n) {
        return {
          chargedCents: 0n,
          shortfallCents: 0n,
          balanceCents: 0n,
          carryMicroCents,
        };
      }
    }

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
    const charge = requested <= totalAvailable ? requested : totalAvailable;
    // A shortfall is not re-banked into the carry: credit_balances forbids an
    // overdraft, so an org that outran its credits mid-turn owes nothing later.
    // The pre-turn guard is what stops it happening.
    const shortfall = requested - charge;

    if (charge <= 0n) {
      return {
        chargedCents: 0n,
        shortfallCents: shortfall,
        balanceCents: totalAvailable,
        carryMicroCents,
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
      carryMicroCents,
    };
  });
}
