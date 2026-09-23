// The period statement (pages/billing.md, This period and the four tiles): one
// derivation both the tiles and the table read, so a tile is a rollup of the
// rows beneath it and no figure is computed twice.
//
// Stripe holds the plan and the invoice. Oxagen holds the meter. The
// statement has the design's lines and no others: governed actions, tokens,
// evidence retention and the onboarding discount, then the total. The
// governed-action line prices the meter at the contracted rate: in prepaid
// mode, the governed actions bought this period (blocks × block price when the
// purchase is whole blocks at today's block size); in invoice mode, the
// overage past the allowance and what was carried in, at the per-action rate.
// The line is labelled with the count it priced, and the Governed actions
// tile prints that same count: one number in both places, never a second
// derivation (pages/billing.md, "headers are rollups"). Tokens are reported at zero:
// Oxagen does not price them. Evidence retention is zero while the
// organization has not opted into extended retention, because nothing accrues
// until it does (get_evidence_retention); once it has, the amount is not
// recorded per period. The onboarding discount has no store yet (spec §20,
// deferred; #3845), so its amount is not recorded. The total is the sum after
// the discount, so while any line is not recorded the total is not either,
// and neither is what is due. When every line is recorded the total is summed
// at full precision and rounded to cents once, half to even.
import type {
  ContractRate,
  EvidenceRetention,
  GauBucket,
} from "@/data/contracts/billing";
import {
  type Money,
  moneyFromMicros,
  mulMicros,
  roundToCentsHalfEven,
  sumMoney,
} from "@/data/contracts/money";

/** How the governed-action line was priced, for its basis. */
export type GovernedCharge =
  | { kind: "blocks"; blocks: number; blockPrice: Money }
  | { kind: "bought"; count: number; rate: Money }
  | { kind: "overage"; count: number; rate: Money };

export type Statement = {
  /**
   * The governed actions the line priced: its label's "1 – N" and the figure
   * on the Governed actions tile. Never negative.
   */
  pricedCount: number;
  includedGau: number;
  charge: GovernedCharge;
  governedAmount: Money;
  tokensAmount: Money;
  /** Null when extended retention is on: its per-period amount is not recorded. */
  retentionAmount: Money | null;
  /** Null until the onboarding offer has a store (spec §20, #3845). */
  discountAmount: Money | null;
  /** Null when a line is not recorded or the lines carry more than one currency. */
  total: Money | null;
  currency: string;
};

function governedCharge(bucket: GauBucket, rate: ContractRate): GovernedCharge {
  if (bucket.mode === "invoice") {
    const count = Math.max(
      0,
      bucket.usedGau -
        bucket.includedGau -
        bucket.carriedGau -
        bucket.purchasedGau,
    );
    return { kind: "overage", count, rate: rate.ratePerGau };
  }
  if (bucket.purchasedGau % rate.blockSizeGau === 0) {
    return {
      kind: "blocks",
      blocks: bucket.purchasedGau / rate.blockSizeGau,
      blockPrice: rate.blockPrice,
    };
  }
  return { kind: "bought", count: bucket.purchasedGau, rate: rate.ratePerGau };
}

function chargeAmount(charge: GovernedCharge): Money {
  switch (charge.kind) {
    case "blocks":
      return mulMicros(charge.blockPrice, charge.blocks);
    case "bought":
    case "overage":
      return mulMicros(charge.rate, charge.count);
  }
}

/** The governed actions a charge priced. */
function pricedCount(charge: GovernedCharge, blockSizeGau: number): number {
  switch (charge.kind) {
    case "blocks":
      return charge.blocks * blockSizeGau;
    case "bought":
    case "overage":
      return charge.count;
  }
}

export function statementFor({
  bucket,
  rate,
  retention,
  discount,
}: {
  bucket: GauBucket;
  rate: ContractRate;
  retention: EvidenceRetention;
  /**
   * The onboarding discount as a negative amount, zero when the organization
   * has no offer, or null while no store records it (spec §20, #3845).
   */
  discount: Money | null;
}): Statement {
  const currency = rate.ratePerGau.currency;
  const zero = moneyFromMicros("0", currency);
  const charge = governedCharge(bucket, rate);
  const governedAmount = chargeAmount(charge);
  const retentionAmount = retention.extendedRetentionEnabled ? null : zero;
  const lines: (Money | null)[] = [
    governedAmount,
    zero,
    retentionAmount,
    discount,
  ];
  const recorded = lines.filter((line): line is Money => line !== null);
  const sum = recorded.length === lines.length ? sumMoney(recorded) : null;
  return {
    pricedCount: pricedCount(charge, rate.blockSizeGau),
    includedGau: bucket.includedGau,
    charge,
    governedAmount,
    tokensAmount: zero,
    retentionAmount,
    discountAmount: discount,
    total: sum === null ? null : roundToCentsHalfEven(sum),
    currency,
  };
}
