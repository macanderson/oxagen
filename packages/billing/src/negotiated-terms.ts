/**
 * negotiated-terms.ts: the one writer of `billing.contract_terms`
 * (ADR-055 §2, `set_contract_terms`).
 *
 * contract-terms.ts reads the table on every governed action; this module
 * writes it, and only a platform operator reaches it. A new agreement closes
 * the org's open row at the instant the new one starts and inserts the new
 * row, in one transaction, so the reader never sees two open rows or a gap.
 *
 * Validation runs before any statement and mirrors the table's CHECKs, so a
 * bad figure is refused with a reason an operator can act on rather than a
 * constraint name:
 *   rate_per_gau_micros >= 0, block_size_gau > 0, included_gau_per_month >= 0,
 *   (rate_per_gau_micros * block_size_gau) % 10000 = 0 (a block costs whole
 *   cents), effective_to > effective_from.
 *
 * Re-running the same terms is a no-op: when the open row already carries the
 * same agreement and figures, nothing is written and `changed` is false.
 */

// tenancy: system bypass via withSystemDb in replaceNegotiatedTerms. The one
// caller is set_contract_terms, an unscoped platformOnly capability keyed on
// its input's orgId; there is no tenant scope for withTenantDb to read.

import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { logger } from "./logger";

/** Why a set of terms was refused. Stable: the handler and the script key on it. */
export type ContractTermsRefusal =
  | "agreement_ref"
  | "currency"
  | "rate"
  | "block_size"
  | "included"
  | "block_not_whole_cents"
  | "effective_from"
  | "starts_before_current";

/** A refused set of terms. `code` is what the handler maps to `invalid_input`. */
export class ContractTermsError extends Error {
  readonly code = "invalid_contract_terms" as const;
  constructor(
    readonly reason: ContractTermsRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ContractTermsError";
  }
}

/** One negotiated agreement, as the operator states it. */
export interface NegotiatedTerms {
  orgId: string;
  agreementRef: string;
  /** ISO 4217, lower case. */
  currency: string;
  /** Micro-units of the currency per governed action unit. */
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  effectiveFrom: Date;
}

/** A stored `contract_terms` row. */
export interface StoredNegotiatedTerms extends NegotiatedTerms {
  id: string;
  effectiveTo: Date | null;
}

/** The two integer columns are Postgres `integer`. */
const INT4_MAX = 2_147_483_647;

/** Refuse terms the table would refuse, before any statement runs. */
export function assertNegotiatedTerms(t: NegotiatedTerms): void {
  const refuse = (reason: ContractTermsRefusal, message: string): never => {
    throw new ContractTermsError(reason, message);
  };
  if (t.agreementRef.trim() === "" || t.agreementRef.length > 140) {
    refuse(
      "agreement_ref",
      "The agreement reference must be 1 to 140 characters.",
    );
  }
  if (!/^[a-z]{3}$/.test(t.currency)) {
    refuse(
      "currency",
      `The currency must be an ISO 4217 code in lower case; got "${t.currency}".`,
    );
  }
  if (t.ratePerGauMicros < 0n) {
    refuse("rate", "The rate per governed action unit cannot be negative.");
  }
  if (
    !Number.isInteger(t.blockSizeGau) ||
    t.blockSizeGau < 1 ||
    t.blockSizeGau > INT4_MAX
  ) {
    refuse(
      "block_size",
      "The block size must be a whole number of units, at least 1.",
    );
  }
  if (
    !Number.isInteger(t.includedGauPerMonth) ||
    t.includedGauPerMonth < 0 ||
    t.includedGauPerMonth > INT4_MAX
  ) {
    refuse(
      "included",
      "The included units per month must be a whole number, 0 or more.",
    );
  }
  const blockMicros = t.ratePerGauMicros * BigInt(t.blockSizeGau);
  if (blockMicros % 10_000n !== 0n) {
    refuse(
      "block_not_whole_cents",
      `A block of ${t.blockSizeGau} units at ${t.ratePerGauMicros} micros each costs ${blockMicros} micros, which is not a whole number of cents. Change the rate or the block size so rate x block size is a multiple of 10,000.`,
    );
  }
  if (Number.isNaN(t.effectiveFrom.getTime())) {
    refuse("effective_from", "The effective date is not a valid instant.");
  }
}

type ContractTermsRow = typeof schema.contractTerms.$inferSelect;

function stored(row: ContractTermsRow): StoredNegotiatedTerms {
  return {
    id: row.id,
    orgId: row.orgId,
    agreementRef: row.agreementRef,
    currency: row.currency,
    ratePerGauMicros: BigInt(row.ratePerGauMicros),
    blockSizeGau: Number(row.blockSizeGau),
    includedGauPerMonth: Number(row.includedGauPerMonth),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

function sameFigures(a: StoredNegotiatedTerms, b: NegotiatedTerms): boolean {
  return (
    a.agreementRef === b.agreementRef &&
    a.currency === b.currency &&
    a.ratePerGauMicros === b.ratePerGauMicros &&
    a.blockSizeGau === b.blockSizeGau &&
    a.includedGauPerMonth === b.includedGauPerMonth
  );
}

export interface ReplacedNegotiatedTerms {
  /** The open row after the call. */
  current: StoredNegotiatedTerms;
  /** The row this call closed, with its new `effectiveTo`; null when none was open. */
  previous: StoredNegotiatedTerms | null;
  /** False when the open row already carried these terms and nothing was written. */
  changed: boolean;
}

/**
 * Make `terms` the org's open agreement from `terms.effectiveFrom`.
 *
 * In one transaction, under an advisory lock on the org: read the open row;
 * return it unchanged when it already carries these figures; refuse when it
 * starts at or after the new start (closing it there would violate
 * `effective_to > effective_from`); otherwise set its `effective_to` to the
 * new start and insert the new row. The partial unique index on the open row
 * backs the lock up.
 */
export async function replaceNegotiatedTerms(
  terms: NegotiatedTerms,
): Promise<ReplacedNegotiatedTerms> {
  assertNegotiatedTerms(terms);
  // tenancy: platform-operator write with no tenant scope, filtered by orgId from
  // the input of set_contract_terms, whose platformOnly binding the kernel verified.
  const result = await withSystemDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`contract_terms:${terms.orgId}`}::text, 0))`,
    );
    const open = await tx
      .select()
      .from(schema.contractTerms)
      .where(
        and(
          eq(schema.contractTerms.orgId, terms.orgId),
          isNull(schema.contractTerms.effectiveTo),
        ),
      )
      .limit(1);
    const current = open[0] ? stored(open[0]) : null;

    if (current && sameFigures(current, terms)) {
      return { current, previous: null, changed: false };
    }
    if (current && current.effectiveFrom >= terms.effectiveFrom) {
      throw new ContractTermsError(
        "starts_before_current",
        `The org's current agreement ${current.agreementRef} starts ${current.effectiveFrom.toISOString()}. New terms must start after it; got ${terms.effectiveFrom.toISOString()}.`,
      );
    }

    let previous: StoredNegotiatedTerms | null = null;
    if (current) {
      const closed = await tx
        .update(schema.contractTerms)
        .set({ effectiveTo: terms.effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.contractTerms.id, current.id))
        .returning();
      previous = closed[0] ? stored(closed[0]) : null;
    }
    const inserted = await tx
      .insert(schema.contractTerms)
      .values({
        orgId: terms.orgId,
        agreementRef: terms.agreementRef,
        currency: terms.currency,
        ratePerGauMicros: terms.ratePerGauMicros,
        blockSizeGau: terms.blockSizeGau,
        includedGauPerMonth: terms.includedGauPerMonth,
        effectiveFrom: terms.effectiveFrom,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("billing: contract_terms insert returned no row");
    return { current: stored(row), previous, changed: true };
  });

  logger.info(
    {
      orgId: terms.orgId,
      agreementRef: result.current.agreementRef,
      effectiveFrom: result.current.effectiveFrom.toISOString(),
      previousAgreementRef: result.previous?.agreementRef ?? null,
      changed: result.changed,
    },
    result.changed
      ? "billing: negotiated contract terms replaced"
      : "billing: negotiated contract terms already in force, nothing written",
  );
  return result;
}
