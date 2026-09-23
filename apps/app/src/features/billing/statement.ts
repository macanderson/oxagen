// The period statement (pages/billing.md, This period and the four tiles): one
// derivation both the tiles and the table read, so a tile is a rollup of the
// rows beneath it and no figure is computed twice.
//
// Stripe holds the plan and the invoice. Oxagen holds the meter. The
// governed-action line prices the meter at the contracted rate: in prepaid
// mode, the governed actions bought this period (blocks × block price when the
// purchase is whole blocks at today's block size); in invoice mode, the
// overage past the allowance and what was carried in, at the per-action rate.
// The plan line is the subscription's own Stripe invoices in the bucket month.
// Tokens are reported at zero: Oxagen does not price them. Evidence retention
// is zero while the organization has not opted into extended retention,
// because nothing accrues until it does (get_evidence_retention); once it has,
// the amount is not recorded per period and the total is not either. The
// total is summed at full precision and rounded to cents once, half to even.
import type {
  ContractRate,
  EvidenceRetention,
  GauBucket,
  InvoiceRow,
  PlanCard,
} from "@/data/contracts/billing";
import {
  type Money,
  moneyFromMicros,
  mulMicros,
  roundToCentsHalfEven,
  sumMoney,
} from "@/data/contracts/money";
import { invoicesInMonth } from "./invoices-in-month";

/** How the governed-action line was priced, for its basis. */
export type GovernedCharge =
  | { kind: "blocks"; blocks: number; blockPrice: Money }
  | { kind: "bought"; count: number; rate: Money }
  | { kind: "overage"; count: number; rate: Money };

export type Statement = {
  /** Governed actions used past the included allowance; never negative. */
  aboveIncluded: number;
  includedGau: number;
  charge: GovernedCharge;
  governedAmount: Money;
  /** Null for an organization with no subscription: the line is not drawn. */
  plan: {
    subscription: NonNullable<PlanCard["subscription"]>;
    invoices: number;
    amount: Money | null;
  } | null;
  tokensAmount: Money;
  /** Null when extended retention is on: its per-period amount is not recorded. */
  retentionAmount: Money | null;
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

export function statementFor({
  plan,
  bucket,
  rate,
  retention,
  invoices,
}: {
  plan: PlanCard;
  bucket: GauBucket;
  rate: ContractRate;
  retention: EvidenceRetention;
  /** The newest invoices page, whatever page the Invoices section shows. */
  invoices: readonly InvoiceRow[];
}): Statement {
  const currency = rate.ratePerGau.currency;
  const zero = moneyFromMicros("0", currency);
  const charge = governedCharge(bucket, rate);
  const governedAmount = chargeAmount(charge);
  const subscription = plan.subscription;
  let planLine: Statement["plan"] = null;
  if (subscription !== null) {
    const rows = invoicesInMonth(invoices, bucket.period).filter(
      (row) => row.kind === "subscription",
    );
    planLine = {
      subscription,
      invoices: rows.length,
      amount:
        rows.length === 0 ? zero : sumMoney(rows.map((row) => row.amountDue)),
    };
  }
  const retentionAmount = retention.extendedRetentionEnabled ? null : zero;
  const lines: (Money | null)[] = [
    governedAmount,
    planLine === null ? zero : planLine.amount,
    zero,
    retentionAmount,
  ];
  const recorded = lines.filter((line): line is Money => line !== null);
  const sum = recorded.length === lines.length ? sumMoney(recorded) : null;
  return {
    aboveIncluded: Math.max(0, bucket.usedGau - bucket.includedGau),
    includedGau: bucket.includedGau,
    charge,
    governedAmount,
    plan: planLine,
    tokensAmount: zero,
    retentionAmount,
    total: sum === null ? null : roundToCentsHalfEven(sum),
    currency,
  };
}
