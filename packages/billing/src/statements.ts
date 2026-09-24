/**
 * statements.ts — the organization's billing statement for one period
 * (ADR-165; contracts `get_billing_statement`, `export_billing_statement`).
 *
 * A statement is built from ledgers only, never from a running total a writer
 * could have drifted, and every figure it prints reconciles against another
 * the same statement carries. The rules, one per section:
 *
 *   Governed action units. Selected from `billing.gau_ledger` on `billed_at`,
 *   the instant the units were added to a month bucket, which is the instant
 *   the bucket (and so every invoice drawn from it) counted them. The total
 *   equals the sum by source, the sum of the daily series, the sum of each
 *   breakdown's rows plus its `other`, and the sum of the overlapping buckets'
 *   `unitsInPeriod`: each ledger row names the bucket it was added to, and
 *   that bucket's month contains its `billed_at`, so it overlaps the period.
 *
 *   Month buckets. `used_gau` only moves through `debitWithLedger`, which adds
 *   exactly the units of the ledger rows it inserts, in the same transaction.
 *   So SUM(units) over a bucket's ledger rows equals its `used_gau` for every
 *   bucket created after the ledger. A bucket from before the ledger reads
 *   `unitemised` by the difference; one where the ledger holds more reads
 *   `mismatch`, and the check that says so fails.
 *
 *   Settlements, reversals, prepaid orders, invoices. Listed when created or
 *   paid in the period, each with the rate it recorded at the time and the
 *   invoice behind it, so a rate change mid-period is visible line by line.
 *   A settlement's subtotal is quantity x rate; what Stripe charged (tax
 *   included) is reported beside it, never recomputed.
 *
 *   Usage credits. Opening = SUM(delta) of `billing.credit_ledger` before the
 *   start; closing = SUM(delta) before the end; closing = opening + additions
 *   - deductions holds by construction, and the check proves the arithmetic
 *   of this build. Credits that expire unused leave their lot without a
 *   ledger entry, so the effective balance on the Billing page can be lower
 *   than the ledger balance by the expired amount. The statement reports the
 *   ledger.
 *
 *   Model usage. `cost.daily_totals` model rows for the UTC days the period
 *   touches, reported with the vendor's list cost and billed at zero.
 *
 * The reads are a port (`StatementReads`) so the arithmetic is unit-tested
 * against fixed rows; `statement-reads.ts` holds the Postgres implementation,
 * which runs every read in one `withOrgDb` transaction (ADR-086), so the
 * figures come from one snapshot of one organization.
 */

import type {
  BillingStatement,
  StatementBucket,
  StatementCheck,
  StatementGroup,
  StatementInvoice,
  StatementOther,
  StatementPeriod,
  StatementPeriodKind,
  StatementPrepaidOrder,
  StatementReversal,
  StatementSettlement,
  StatementSubject,
} from "@oxagen/oxagen/contracts/billing.statement.get";
import type { GauEntitlement } from "./contract-terms";
import { CREDIT_REASONS } from "./constants";

// ── Periods ─────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A custom period must be strictly longer than this. */
const STATEMENT_MIN_CUSTOM_MS = 48 * HOUR_MS;
/** And at most this long. */
const STATEMENT_MAX_MS = 366 * DAY_MS;

/** The period fields as the contract carries them. */
export interface StatementPeriodInput {
  kind: StatementPeriodKind;
  anchor?: string;
  from?: string;
  to?: string;
}

export type StatementPeriodErrorReason =
  | "anchor_required"
  | "anchor_invalid"
  | "range_required"
  | "range_invalid"
  | "range_too_short"
  | "range_too_long"
  | "period_not_started"
  | "unexpected_field";

/** A period the statement cannot be built for. The handler maps it to `invalid_input`. */
export class StatementPeriodError extends Error {
  readonly reason: StatementPeriodErrorReason;
  constructor(reason: StatementPeriodErrorReason, message: string) {
    super(message);
    this.name = "StatementPeriodError";
    this.reason = reason;
  }
}

/** A resolved period: half-open [start, end) in UTC. */
export interface ResolvedStatementPeriod {
  kind: StatementPeriodKind;
  start: Date;
  end: Date;
  label: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function shortMonth(m: number): string {
  return (MONTHS[m] ?? "").slice(0, 3);
}

/** "14 Sep 2026", UTC. */
export function formatStatementDay(at: Date): string {
  return `${at.getUTCDate()} ${shortMonth(at.getUTCMonth())} ${at.getUTCFullYear()}`;
}

function isMidnight(at: Date): boolean {
  return at.getTime() % DAY_MS === 0;
}

/** "14 Sep 2026", or "14 Sep 2026 09:30 UTC" off midnight. */
function formatInstantLabel(at: Date): string {
  if (isMidnight(at)) return formatStatementDay(at);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${formatStatementDay(at)} ${hh}:${mm} UTC`;
}

/** The UTC calendar day of an instant. */
function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The last UTC calendar day a half-open period touches. */
export function lastDayOf(end: Date): string {
  return isoDay(new Date(end.getTime() - 1));
}

function parseAnchor(anchor: string | undefined): Date {
  if (anchor === undefined)
    throw new StatementPeriodError(
      "anchor_required",
      "A week, month, quarter or year needs an anchor date (YYYY-MM-DD).",
    );
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor);
  const at = match
    ? new Date(
        Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
      )
    : null;
  // Date.UTC rolls 2026-02-30 over to 2 March; a round trip catches it.
  if (!at || Number.isNaN(at.getTime()) || isoDay(at) !== anchor)
    throw new StatementPeriodError(
      "anchor_invalid",
      `The anchor ${JSON.stringify(anchor)} is not a calendar date (YYYY-MM-DD).`,
    );
  return at;
}

function parseInstant(raw: string, field: "from" | "to"): Date {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms))
    throw new StatementPeriodError(
      "range_invalid",
      `${field} is not an RFC 3339 instant.`,
    );
  return new Date(ms);
}

/**
 * The period a statement covers: the UTC calendar week (Monday to Sunday),
 * month, quarter or year containing `anchor`, or a custom range `[from, to)`
 * longer than 48 hours and at most 366 days. Refuses a field the kind does
 * not take, and a period that starts after `now`.
 */
export function resolveStatementPeriod(
  input: StatementPeriodInput,
  now: Date = new Date(),
): ResolvedStatementPeriod {
  let resolved: ResolvedStatementPeriod;
  if (input.kind === "custom") {
    if (input.anchor !== undefined)
      throw new StatementPeriodError(
        "unexpected_field",
        "A custom period takes from and to, not an anchor.",
      );
    if (input.from === undefined || input.to === undefined)
      throw new StatementPeriodError(
        "range_required",
        "A custom period needs both from and to.",
      );
    const start = parseInstant(input.from, "from");
    const end = parseInstant(input.to, "to");
    const length = end.getTime() - start.getTime();
    if (length <= STATEMENT_MIN_CUSTOM_MS)
      throw new StatementPeriodError(
        "range_too_short",
        "A custom period must be longer than 48 hours. Use a week or a longer range.",
      );
    if (length > STATEMENT_MAX_MS)
      throw new StatementPeriodError(
        "range_too_long",
        "A custom period can be at most 366 days. Use a year, or split the range.",
      );
    resolved = {
      kind: "custom",
      start,
      end,
      label: `${formatInstantLabel(start)} to ${
        isMidnight(end)
          ? formatStatementDay(new Date(end.getTime() - DAY_MS))
          : formatInstantLabel(end)
      }`,
    };
  } else {
    if (input.from !== undefined || input.to !== undefined)
      throw new StatementPeriodError(
        "unexpected_field",
        `A ${input.kind} takes an anchor date, not from and to.`,
      );
    const anchor = parseAnchor(input.anchor);
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth();
    if (input.kind === "week") {
      // getUTCDay: Sunday 0 … Saturday 6. Monday starts the week.
      const offset = (anchor.getUTCDay() + 6) % 7;
      const start = new Date(anchor.getTime() - offset * DAY_MS);
      resolved = {
        kind: "week",
        start,
        end: new Date(start.getTime() + 7 * DAY_MS),
        label: `Week of ${formatStatementDay(start)}`,
      };
    } else if (input.kind === "month") {
      resolved = {
        kind: "month",
        start: new Date(Date.UTC(y, m, 1)),
        end: new Date(Date.UTC(y, m + 1, 1)),
        label: `${MONTHS[m]} ${y}`,
      };
    } else if (input.kind === "quarter") {
      const q = Math.floor(m / 3);
      resolved = {
        kind: "quarter",
        start: new Date(Date.UTC(y, q * 3, 1)),
        end: new Date(Date.UTC(y, q * 3 + 3, 1)),
        label: `Q${q + 1} ${y}`,
      };
    } else {
      resolved = {
        kind: "year",
        start: new Date(Date.UTC(y, 0, 1)),
        end: new Date(Date.UTC(y + 1, 0, 1)),
        label: String(y),
      };
    }
  }
  if (resolved.start.getTime() > now.getTime())
    throw new StatementPeriodError(
      "period_not_started",
      "The period starts in the future, so there is nothing to state yet.",
    );
  return resolved;
}

function stamp(at: Date): string {
  const iso = at.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  if (isMidnight(at)) return date;
  return `${date}T${iso.slice(11, 19).replace(/:/g, "")}Z`;
}

/**
 * `ST-<first 8 hex of the org id>-<start>-<last day>`, upper case. The same
 * organization and period always give the same reference, so a statement
 * regenerated later is recognisably the same document. Off-midnight bounds
 * carry their time, so two custom ranges on the same days stay distinct.
 */
export function statementReference(
  orgId: string,
  period: Pick<ResolvedStatementPeriod, "start" | "end">,
): string {
  const org = orgId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const endStamp = isMidnight(period.end)
    ? lastDayOf(period.end).replace(/-/g, "")
    : stamp(period.end);
  return `ST-${org}-${stamp(period.start)}-${endStamp}`;
}

/** Every UTC calendar day `[start, end)` touches, in order. */
export function statementDays(
  period: Pick<ResolvedStatementPeriod, "start" | "end">,
): string[] {
  const days: string[] = [];
  const first = Date.UTC(
    period.start.getUTCFullYear(),
    period.start.getUTCMonth(),
    period.start.getUTCDate(),
  );
  const last = lastDayOf(period.end);
  for (let t = first; ; t += DAY_MS) {
    const d = isoDay(new Date(t));
    days.push(d);
    if (d >= last) break;
  }
  return days;
}

// ── The reads ───────────────────────────────────────────────────────────────

/** Half-open [start, end), the one shape every read takes. */
export interface PeriodBounds {
  start: Date;
  end: Date;
}

export interface UnitsRow {
  units: number;
  actions: number;
}

export interface KeyedUnitsRow extends UnitsRow {
  key: string | null;
}

/** The top groups of one dimension and how many groups there are in all. */
export interface GroupedRows<R> {
  rows: R[];
  groups: number;
}

export interface SubjectRow extends UnitsRow {
  capability: string | null;
  toolName: string | null;
  mcpServer: string | null;
}

export interface BucketRead {
  periodStart: Date;
  periodEnd: Date;
  includedGau: number;
  purchasedGau: number;
  carriedGau: number;
  usedGau: number;
  overageInvoicedGau: number;
  closedAt: Date | null;
  ledgerUnits: number;
  unitsInPeriod: number;
}

export interface InvoiceRefRead {
  number: string | null;
  status: string;
  hostedInvoiceUrl: string | null;
}

export interface SettlementRead {
  id: string;
  kind: string;
  status: string;
  quantityGau: number;
  ratePerGauMicros: bigint;
  chargedCents: number | null;
  currency: string;
  createdAt: Date;
  settledAt: Date | null;
  invoice: InvoiceRefRead | null;
}

export interface ReversalRead {
  id: string;
  kind: string;
  settlementId: string | null;
  requestedGau: number;
  reversedGau: number;
  unrecoveredGau: number;
  amountCents: number;
  currency: string;
  createdAt: Date;
}

export interface PrepaidOrderRead {
  id: string;
  status: string;
  agreementRef: string | null;
  poNumber: string | null;
  currency: string;
  licenceCents: number;
  licencePeriodStart: Date | null;
  licencePeriodEnd: Date | null;
  gauQuantity: number;
  ratePerGauMicros: bigint;
  creditCents: number;
  createdAt: Date;
  paidAt: Date | null;
  invoice: InvoiceRefRead | null;
}

export interface InvoiceRead {
  publicId: string;
  number: string | null;
  status: string;
  /** `gau_settlements.kind` of a settlement naming this invoice, or null. */
  settlementKind: string | null;
  /** A prepaid order names this invoice. */
  prepaid: boolean;
  amountDueCents: number;
  amountPaidCents: number;
  amountRemainingCents: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  dueAt: Date | null;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface CreditMovementRead {
  reason: string;
  /** Signed sum of delta_cents for this reason and sign. */
  cents: bigint;
  entries: number;
}

export interface AssistantOperatorRead {
  /** credit_ledger.created_by_id, or null. */
  key: string | null;
  /** Positive: the credits deducted. */
  cents: bigint;
  entries: number;
}

export interface ModelUsageRead {
  provider: string | null;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint | null;
  currency: string;
}

export interface AgreementRead {
  agreementRef: string;
  currency: string;
  ratePerGauMicros: bigint;
  includedGauPerMonth: number;
  blockSizeGau: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** Human labels by raw id. A missing id is a record the store no longer names. */
export interface StatementLabels {
  workspaces: ReadonlyMap<string, string>;
  agents: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
}

export type LedgerDimension = "workspace" | "agent" | "operator";

/**
 * What a statement reads. Every method answers for one organization and one
 * half-open period; the Postgres implementation runs them on one
 * transaction.
 */
export interface StatementReads {
  org(
    orgId: string,
  ): Promise<{ id: string; name: string; slug: string } | null>;
  entitlement(orgId: string, asOf: Date): Promise<GauEntitlement>;
  agreements(orgId: string, p: PeriodBounds): Promise<AgreementRead[]>;
  ledgerBySource(
    orgId: string,
    p: PeriodBounds,
  ): Promise<(UnitsRow & { source: string })[]>;
  ledgerBy(
    orgId: string,
    p: PeriodBounds,
    dimension: LedgerDimension,
    top: number,
  ): Promise<GroupedRows<KeyedUnitsRow>>;
  ledgerBySubject(
    orgId: string,
    p: PeriodBounds,
    top: number,
  ): Promise<GroupedRows<SubjectRow>>;
  ledgerDaily(
    orgId: string,
    p: PeriodBounds,
  ): Promise<(UnitsRow & { date: string })[]>;
  buckets(orgId: string, p: PeriodBounds): Promise<BucketRead[]>;
  settlements(orgId: string, p: PeriodBounds): Promise<SettlementRead[]>;
  reversals(orgId: string, p: PeriodBounds): Promise<ReversalRead[]>;
  prepaidOrders(orgId: string, p: PeriodBounds): Promise<PrepaidOrderRead[]>;
  invoices(orgId: string, p: PeriodBounds): Promise<InvoiceRead[]>;
  /** SUM(delta_cents) of entries created before `at`. */
  creditBalanceBefore(orgId: string, at: Date): Promise<bigint>;
  creditMovements(
    orgId: string,
    p: PeriodBounds,
  ): Promise<{
    additions: CreditMovementRead[];
    deductions: CreditMovementRead[];
  }>;
  assistantByOperator(
    orgId: string,
    p: PeriodBounds,
  ): Promise<AssistantOperatorRead[]>;
  modelUsage(
    orgId: string,
    days: { first: string; last: string },
  ): Promise<ModelUsageRead[]>;
  labels(
    orgId: string,
    ids: { workspaces: string[]; agents: string[]; users: string[] },
  ): Promise<StatementLabels>;
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** Stripe's integer cents as integer micro-units, as a decimal string. */
function centsToMicrosString(cents: number | bigint): string {
  if (typeof cents === "number" && !Number.isSafeInteger(cents))
    throw new RangeError(`cents must be a safe integer: ${String(cents)}`);
  return (BigInt(cents) * 10_000n).toString();
}

function iso(at: Date): string {
  return at.toISOString();
}

function isoOrNull(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

function other<R extends UnitsRow>(
  rows: R[],
  groups: number,
  total: UnitsRow,
): StatementOther {
  const units = rows.reduce((n, r) => n + r.units, 0);
  const actions = rows.reduce((n, r) => n + r.actions, 0);
  return {
    groups: Math.max(0, groups - rows.length),
    units: Math.max(0, total.units - units),
    actions: Math.max(0, total.actions - actions),
  };
}

function labelled(
  grouped: GroupedRows<KeyedUnitsRow>,
  labels: ReadonlyMap<string, string>,
  total: UnitsRow,
): { rows: StatementGroup[]; other: StatementOther } {
  return {
    rows: grouped.rows.map((r) => ({
      key: r.key,
      label: r.key === null ? null : (labels.get(r.key) ?? null),
      units: r.units,
      actions: r.actions,
    })),
    other: other(grouped.rows, grouped.groups, total),
  };
}

const SETTLEMENT_TO_INVOICE_KIND: Readonly<
  Record<string, StatementInvoice["kind"]>
> = {
  checkout: "gau_purchase",
  auto_topup: "gau_auto_topup",
  interim_invoice: "gau_interim",
  period_close: "gau_period_close",
};

function invoiceKind(row: InvoiceRead): StatementInvoice["kind"] {
  if (row.settlementKind !== null) {
    const kind = Object.hasOwn(SETTLEMENT_TO_INVOICE_KIND, row.settlementKind)
      ? SETTLEMENT_TO_INVOICE_KIND[row.settlementKind]
      : undefined;
    if (!kind)
      throw new RangeError(
        `settlement kind outside the CHECK: ${row.settlementKind}`,
      );
    return kind;
  }
  return row.prepaid ? "prepaid_order" : "subscription";
}

function invoiceRef(ref: InvoiceRefRead | null) {
  return ref === null
    ? null
    : {
        number: ref.number,
        status: ref.status,
        hostedInvoiceUrl: ref.hostedInvoiceUrl,
      };
}

function bucketOf(b: BucketRead): StatementBucket {
  const remaining = b.includedGau + b.purchasedGau + b.carriedGau - b.usedGau;
  return {
    periodStart: iso(b.periodStart),
    periodEnd: iso(b.periodEnd),
    includedGau: b.includedGau,
    purchasedGau: b.purchasedGau,
    carriedGau: b.carriedGau,
    usedGau: b.usedGau,
    overageInvoicedGau: b.overageInvoicedGau,
    remainingGau: remaining,
    overageGau: Math.max(0, -remaining),
    closedAt: isoOrNull(b.closedAt),
    unitsInPeriod: b.unitsInPeriod,
    ledgerUnits: b.ledgerUnits,
    reconciliation:
      b.ledgerUnits === b.usedGau
        ? "matched"
        : b.ledgerUnits < b.usedGau
          ? "unitemised"
          : "mismatch",
  };
}

function settlementOf(s: SettlementRead): StatementSettlement {
  return {
    id: s.id,
    kind: s.kind as StatementSettlement["kind"],
    status: s.status as StatementSettlement["status"],
    quantityGau: s.quantityGau,
    ratePerGauMicros: s.ratePerGauMicros.toString(),
    subtotalMicros: (BigInt(s.quantityGau) * s.ratePerGauMicros).toString(),
    chargedMicros:
      s.chargedCents === null ? null : centsToMicrosString(s.chargedCents),
    currency: s.currency,
    createdAt: iso(s.createdAt),
    settledAt: isoOrNull(s.settledAt),
    invoice: invoiceRef(s.invoice),
  };
}

function reversalOf(r: ReversalRead): StatementReversal {
  return {
    id: r.id,
    kind: r.kind as StatementReversal["kind"],
    settlementId: r.settlementId,
    requestedGau: r.requestedGau,
    reversedGau: r.reversedGau,
    unrecoveredGau: r.unrecoveredGau,
    amountMicros: centsToMicrosString(r.amountCents),
    currency: r.currency,
    createdAt: iso(r.createdAt),
  };
}

function prepaidOf(o: PrepaidOrderRead): StatementPrepaidOrder {
  const licence = BigInt(o.licenceCents) * 10_000n;
  const units = BigInt(o.gauQuantity) * o.ratePerGauMicros;
  const credit = BigInt(o.creditCents) * 10_000n;
  return {
    id: o.id,
    status: o.status as StatementPrepaidOrder["status"],
    agreementRef: o.agreementRef,
    poNumber: o.poNumber,
    currency: o.currency,
    licenceMicros: licence.toString(),
    licencePeriodStart: isoOrNull(o.licencePeriodStart),
    licencePeriodEnd: isoOrNull(o.licencePeriodEnd),
    gauQuantity: o.gauQuantity,
    ratePerGauMicros: o.ratePerGauMicros.toString(),
    gauMicros: units.toString(),
    creditMicros: credit.toString(),
    totalMicros: (licence + units + credit).toString(),
    createdAt: iso(o.createdAt),
    paidAt: isoOrNull(o.paidAt),
    invoice: invoiceRef(o.invoice),
  };
}

function invoiceOf(i: InvoiceRead): StatementInvoice {
  return {
    publicId: i.publicId,
    number: i.number,
    status: i.status as StatementInvoice["status"],
    kind: invoiceKind(i),
    amountDueMicros: centsToMicrosString(i.amountDueCents),
    amountPaidMicros: centsToMicrosString(i.amountPaidCents),
    amountRemainingMicros: centsToMicrosString(i.amountRemainingCents),
    currency: i.currency,
    periodStart: iso(i.periodStart),
    periodEnd: iso(i.periodEnd),
    issuedAt: iso(i.createdAt),
    dueAt: isoOrNull(i.dueAt),
    paidAt: isoOrNull(i.paidAt),
    hostedInvoiceUrl: i.hostedInvoiceUrl,
    invoicePdfUrl: i.invoicePdfUrl,
  };
}

function invoiceTotals(invoices: StatementInvoice[]) {
  const byCurrency = new Map<
    string,
    { invoices: number; due: bigint; paid: bigint; remaining: bigint }
  >();
  for (const i of invoices) {
    // A void invoice is listed and owes nothing; its figures stay on its line.
    if (i.status === "void") continue;
    const t = byCurrency.get(i.currency) ?? {
      invoices: 0,
      due: 0n,
      paid: 0n,
      remaining: 0n,
    };
    t.invoices += 1;
    t.due += BigInt(i.amountDueMicros);
    t.paid += BigInt(i.amountPaidMicros);
    t.remaining += BigInt(i.amountRemainingMicros);
    byCurrency.set(i.currency, t);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      invoices: t.invoices,
      dueMicros: t.due.toString(),
      paidMicros: t.paid.toString(),
      remainingMicros: t.remaining.toString(),
    }));
}

const SOURCES = ["kernel", "tacho", "external_tool"] as const;

export interface BuildStatementOptions {
  /** The instant the statement is generated at. Defaults to now. */
  now?: Date;
  /** Breakdown rows per dimension. */
  top?: number;
}

/**
 * Build the statement for one organization and period from `reads`. Pure
 * arithmetic over what the reads answer; no read is made twice.
 */
export async function assembleBillingStatement(
  reads: StatementReads,
  orgId: string,
  period: ResolvedStatementPeriod,
  opts: BuildStatementOptions = {},
): Promise<BillingStatement> {
  const now = opts.now ?? new Date();
  const top = opts.top ?? 25;
  const p: PeriodBounds = { start: period.start, end: period.end };
  const provisional = period.end.getTime() > now.getTime();
  // Terms at the last instant the statement covers.
  const asOf = new Date(Math.min(period.end.getTime() - 1, now.getTime()));
  const days = statementDays(p);
  const first = days[0] as string;
  const last = days[days.length - 1] as string;

  // Sequential on purpose: the Postgres reads share one transaction, which
  // runs one statement at a time whatever the caller does.
  const org = await reads.org(orgId);
  if (!org) throw new Error(`billing statement: no organization ${orgId}`);
  const entitlement = await reads.entitlement(orgId, asOf);
  const agreements = await reads.agreements(orgId, p);
  const bySource = await reads.ledgerBySource(orgId, p);
  const byWorkspace = await reads.ledgerBy(orgId, p, "workspace", top);
  const byAgent = await reads.ledgerBy(orgId, p, "agent", top);
  const byOperator = await reads.ledgerBy(orgId, p, "operator", top);
  const bySubject = await reads.ledgerBySubject(orgId, p, top);
  const daily = await reads.ledgerDaily(orgId, p);
  const buckets = await reads.buckets(orgId, p);
  const settlements = await reads.settlements(orgId, p);
  const reversals = await reads.reversals(orgId, p);
  const prepaid = await reads.prepaidOrders(orgId, p);
  const invoiceRows = await reads.invoices(orgId, p);
  const opening = await reads.creditBalanceBefore(orgId, period.start);
  // Read, not derived: the roll-forward check below compares the two.
  const closing = await reads.creditBalanceBefore(orgId, period.end);
  const movements = await reads.creditMovements(orgId, p);
  const assistant = await reads.assistantByOperator(orgId, p);
  const models = await reads.modelUsage(orgId, { first, last });

  const assistantUsers = assistant
    .map((a) => a.key)
    .filter((k): k is string => k !== null);
  const labels = await reads.labels(orgId, {
    workspaces: byWorkspace.rows
      .map((r) => r.key)
      .filter((k): k is string => k !== null),
    agents: byAgent.rows
      .map((r) => r.key)
      .filter((k): k is string => k !== null),
    users: [
      ...byOperator.rows
        .map((r) => r.key)
        .filter((k): k is string => k !== null),
      ...assistantUsers,
    ],
  });

  // ── Governed actions ──
  const sourceMap = new Map(bySource.map((r) => [r.source, r]));
  const sources = SOURCES.map((source) => ({
    source,
    units: sourceMap.get(source)?.units ?? 0,
    actions: sourceMap.get(source)?.actions ?? 0,
  }));
  const total: UnitsRow = {
    units: sources.reduce((n, s) => n + s.units, 0),
    actions: sources.reduce((n, s) => n + s.actions, 0),
  };
  const dailyMap = new Map(daily.map((d) => [d.date, d]));
  const dailySeries = days.map((date) => ({
    date,
    units: dailyMap.get(date)?.units ?? 0,
    actions: dailyMap.get(date)?.actions ?? 0,
  }));
  const subjects: StatementSubject[] = bySubject.rows.map((r) => ({
    capability: r.capability,
    toolName: r.toolName,
    mcpServer: r.mcpServer,
    units: r.units,
    actions: r.actions,
  }));
  const governedActions = {
    totalUnits: total.units,
    totalActions: total.actions,
    bySource: sources,
    byWorkspace: labelled(byWorkspace, labels.workspaces, total),
    byAgent: labelled(byAgent, labels.agents, total),
    byOperator: labelled(byOperator, labels.users, total),
    bySubject: {
      rows: subjects,
      other: other(bySubject.rows, bySubject.groups, total),
    },
    daily: dailySeries,
  };

  // ── Buckets and money records ──
  const statementBuckets = buckets.map(bucketOf);
  const invoices = invoiceRows.map(invoiceOf);

  // ── Usage credits ──
  const added = movements.additions.reduce((n, m) => n + m.cents, 0n);
  const deducted = movements.deductions.reduce((n, m) => n + -m.cents, 0n);
  const assistantTotal = movements.deductions
    .filter((m) => m.reason === CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS)
    .reduce((n, m) => n + -m.cents, 0n);
  const attributed = assistant.filter((a) => a.key !== null);
  const unattributed = assistant
    .filter((a) => a.key === null)
    .reduce((n, a) => n + a.cents, 0n);
  const byReason = (rows: CreditMovementRead[], sign: 1n | -1n) =>
    [...rows]
      .sort((a, b) => a.reason.localeCompare(b.reason))
      .map((m) => ({
        reason: m.reason,
        credits: (m.cents * sign).toString(),
        entries: m.entries,
      }));

  // ── Model usage ──
  const sortedModels = [...models].sort(
    (a, b) => b.calls - a.calls || a.model.localeCompare(b.model),
  );
  const topModels = sortedModels.slice(0, top);
  const restModels = sortedModels.slice(top);

  // ── Reconciliation ──
  const sum = (rows: UnitsRow[]) => rows.reduce((n, r) => n + r.units, 0);
  const breakdownHolds = (b: { rows: UnitsRow[]; other: StatementOther }) =>
    sum(b.rows) + b.other.units === total.units;
  const checks: StatementCheck[] = [
    {
      id: "units_by_day",
      statement: "The daily series adds up to the total governed action units.",
      holds: sum(dailySeries) === total.units,
    },
    {
      id: "units_by_dimension",
      statement:
        "Each breakdown (workspace, agent, operator, capability or tool) adds up to the total, counting its other row.",
      holds:
        breakdownHolds(governedActions.byWorkspace) &&
        breakdownHolds(governedActions.byAgent) &&
        breakdownHolds(governedActions.byOperator) &&
        breakdownHolds(governedActions.bySubject),
    },
    {
      id: "units_by_bucket",
      statement:
        "The units each listed month bucket received in this period add up to the total, so every unit billed in the period landed in a bucket whose month overlaps it.",
      holds:
        sum(buckets.map((b) => ({ units: b.unitsInPeriod, actions: 0 }))) ===
        total.units,
    },
    {
      id: "bucket_ledger",
      statement:
        "No month bucket holds fewer used units than its ledger rows. A bucket from before the ledger is marked unitemised by the difference.",
      holds: statementBuckets.every((b) => b.reconciliation !== "mismatch"),
    },
    {
      id: "credits_roll_forward",
      statement:
        "Usage credits: the opening balance plus additions minus deductions equals the closing balance, and the assistant's deductions by operator add up to its total.",
      holds:
        opening + added - deducted === closing &&
        assistantTotal ===
          attributed.reduce((n, a) => n + a.cents, 0n) + unattributed,
    },
  ];

  const terms = entitlement.terms;
  return {
    version: 1,
    reference: statementReference(orgId, period),
    generatedAt: iso(now),
    provisional,
    org,
    period: {
      kind: period.kind,
      start: iso(period.start),
      end: iso(period.end),
      lastDay: lastDayOf(period.end),
      label: period.label,
    } satisfies StatementPeriod,
    terms: {
      source: terms.source,
      tier: terms.tier,
      agreementRef: terms.source === "negotiated" ? terms.agreementRef : null,
      currency: terms.currency,
      ratePerGauMicros: terms.ratePerGauMicros.toString(),
      blockSizeGau: terms.blockSizeGau,
      includedGauPerMonth: terms.includedGauPerMonth,
      asOf: iso(asOf),
    },
    agreements: agreements.map((a) => ({
      agreementRef: a.agreementRef,
      currency: a.currency,
      ratePerGauMicros: a.ratePerGauMicros.toString(),
      includedGauPerMonth: a.includedGauPerMonth,
      blockSizeGau: a.blockSizeGau,
      effectiveFrom: iso(a.effectiveFrom),
      effectiveTo: isoOrNull(a.effectiveTo),
    })),
    governedActions,
    buckets: statementBuckets,
    settlements: settlements.map(settlementOf),
    reversals: reversals.map(reversalOf),
    prepaidOrders: prepaid.map(prepaidOf),
    invoices,
    invoiceTotals: invoiceTotals(invoices),
    usageCredits: {
      openingCredits: opening.toString(),
      additions: byReason(movements.additions, 1n),
      deductions: byReason(movements.deductions, -1n),
      closingCredits: closing.toString(),
      assistantCredits: assistantTotal.toString(),
      assistantByOperator: attributed
        .sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0))
        .map((a) => ({
          key: a.key as string,
          label: labels.users.get(a.key as string) ?? null,
          credits: a.cents.toString(),
          entries: a.entries,
        })),
      assistantUnattributedCredits: unattributed.toString(),
    },
    modelUsage: {
      rows: topModels.map((m) => ({
        provider: m.provider,
        model: m.model,
        calls: m.calls,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        reportedCostMicros:
          m.costMicros === null ? null : m.costMicros.toString(),
        currency: m.currency,
      })),
      other: {
        groups: restModels.length,
        calls: restModels.reduce((n, m) => n + m.calls, 0),
        inputTokens: restModels.reduce((n, m) => n + m.inputTokens, 0),
        outputTokens: restModels.reduce((n, m) => n + m.outputTokens, 0),
      },
      billedMicros: "0",
    },
    reconciliation: checks,
  };
}

// ── Line items (the CSV rows) ───────────────────────────────────────────────

/** One `billing.gau_ledger` row, with its labels. */
export interface StatementLineItem {
  id: string;
  /** RFC 3339 with microseconds, as stored: the keyset position. */
  billedAt: string;
  occurredAt: string;
  source: string;
  capability: string | null;
  toolName: string | null;
  mcpServer: string | null;
  surface: string | null;
  harness: string | null;
  workspaceId: string | null;
  workspace: string | null;
  agentId: string | null;
  agent: string | null;
  operatorUserId: string | null;
  operator: string | null;
  principalId: string | null;
  principalKind: string | null;
  runId: string | null;
  sessionId: string | null;
  toolCallId: string | null;
  requestId: string | null;
  units: number;
}

/** Where a page of line items ended: the last row's billed instant and id. */
export interface LineItemPosition {
  billedAt: string;
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsecond RFC 3339 in UTC, the shape the page query writes. */
const MICRO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * An opaque cursor bound to its period, so a cursor from one statement
 * cannot page another.
 */
export function encodeLineItemCursor(
  period: PeriodBounds,
  at: LineItemPosition,
): string {
  return Buffer.from(
    JSON.stringify([
      "st1",
      period.start.toISOString(),
      period.end.toISOString(),
      at.billedAt,
      at.id,
    ]),
    "utf8",
  ).toString("base64url");
}

/** Null for anything that is not a cursor this module wrote for `period`. */
export function decodeLineItemCursor(
  raw: string,
  period: PeriodBounds,
): LineItemPosition | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      value[0] !== "st1" ||
      value[1] !== period.start.toISOString() ||
      value[2] !== period.end.toISOString() ||
      typeof value[3] !== "string" ||
      !MICRO_INSTANT_RE.test(value[3]) ||
      typeof value[4] !== "string" ||
      !UUID_RE.test(value[4])
    )
      return null;
    return { billedAt: value[3], id: value[4] };
  } catch {
    // Not base64url JSON: a hand-edited or foreign cursor.
    return null;
  }
}
