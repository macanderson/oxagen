/**
 * action-meter-format.ts — the presentation vocabulary for the governed-action
 * meter (ADR-052).
 *
 * Every function here exists because a number in this domain has a wrong way to
 * render it that looks perfectly reasonable. ADR-052 replaced a cost-derived
 * meter precisely because a customer could not check its arithmetic, so the
 * presentation layer is not allowed to reintroduce an unanswerable figure:
 *
 *   - a null allowance is NEGOTIATED, not unlimited and not blank;
 *   - an unmeasured volume is UNCOUNTED, not zero;
 *   - a zero token rate is a PRICE, not a missing row.
 *
 * Pure: no React, no I/O. The honesty rules are therefore unit-testable
 * independently of whatever chrome renders them.
 */

/** Rendered wherever a tier's included allowance is negotiated per contract. */
export const NEGOTIATED_ALLOWANCE_LABEL = "Negotiated per contract";

/**
 * Rendered wherever a stored-volume figure has not been measured.
 *
 * Never "0 GB": zero is the claim "you are storing nothing", which is a
 * different and probably false statement about an organisation whose evidence
 * simply has not been counted yet.
 */
export const NOT_MEASURED_LABEL = "Not measured yet";

/** Rendered when an organisation has pinned no retention policy at all. */
export const NO_RETENTION_POLICY_LABEL = "No policy pinned";

/** One credit is worth one US cent. Locked business rule (@oxagen/billing). */
const USD_PER_CREDIT = 0.01;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Whole-number counts with thousands separators. */
export function formatActions(count: number): string {
  if (!Number.isFinite(count)) return "—";
  return Math.max(0, Math.floor(count)).toLocaleString("en-US");
}

/**
 * A tier's included annual allowance.
 *
 * `null` means the figure is negotiated per contract (spec §7.3). It is
 * rendered as words. An infinity glyph would promise unlimited usage nobody
 * agreed to, and a blank cell would read as an unfinished page.
 */
export function formatIncludedAllowance(value: number | null): string {
  if (value === null || value === undefined) return NEGOTIATED_ALLOWANCE_LABEL;
  return `${formatActions(value)} actions`;
}

/**
 * Evidence volume held beyond the included window.
 *
 * `measured === false` wins over whatever is in `gb` — the accounting job has
 * not run, so there is no measurement to render at any precision.
 */
export function formatStoredGb(gb: number | null, measured: boolean): string {
  if (!measured || gb === null || gb === undefined) return NOT_MEASURED_LABEL;
  return `${gb.toLocaleString("en-US", { maximumFractionDigits: 2 })} GB`;
}

/** Credits (cents) as dollars. */
export function formatCreditsUsd(credits: number): string {
  if (!Number.isFinite(credits)) return "—";
  return usd.format(Math.max(0, credits) * USD_PER_CREDIT);
}

/** Plain USD. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return usd.format(Math.max(0, value));
}

/** USD at rate-card precision (a band price is $20.00 / 1,000, not $20). */
export function formatUsdRate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return usdPrecise.format(Math.max(0, value));
}

/** Micro-USD (ClickHouse token cost) as dollars. */
export function formatUsdFromMicros(micros: number): string {
  if (!Number.isFinite(micros)) return "—";
  return usdPrecise.format(Math.max(0, micros) / 1_000_000);
}

/** A volume band's action range, e.g. "1,000,000 – 4,999,999" or "5,000,000+". */
export function formatBandRange(band: {
  minAnnualActions: number;
  maxAnnualActions: number | null;
}): string {
  const min = formatActions(band.minAnnualActions);
  if (band.maxAnnualActions === null) return `${min}+`;
  return `${min} – ${formatActions(band.maxAnnualActions - 1)}`;
}

/**
 * The organisation's effective retention window.
 *
 * `null` means no policy is pinned. That is NOT "kept forever" and NOT zero
 * days, so it renders as its own phrase rather than as a number.
 */
export function formatRetentionWindow(days: number | null): string {
  if (days === null || days === undefined) return NO_RETENTION_POLICY_LABEL;
  const months = days / 30;
  if (months >= 2) {
    return `${days.toLocaleString("en-US")} days (~${Math.round(months)} months)`;
  }
  return `${days.toLocaleString("en-US")} days`;
}

/** An ISO instant as a plain UTC date, e.g. "1 Jan 2026". */
export function formatIsoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "1 Jan 2026 – 1 Jan 2027" for the entitlement year header. */
export function formatPeriod(period: { start: string; end: string }): string {
  return `${formatIsoDate(period.start)} – ${formatIsoDate(period.end)}`;
}

/** Human labels for the four published run classes (spec §3.4). */
export const RUN_CLASS_LABELS: Readonly<Record<string, string>> = {
  qa_lookup: "Q&A / lookup",
  standard_task: "Standard task",
  multi_step: "Multi-step / coding",
  long_running: "Long-running workflow",
};

/** Human labels for plan tiers. */
export const TIER_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  build: "Build",
  scale: "Scale",
  enterprise: "Enterprise",
};

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

export function runClassLabel(runClass: string): string {
  return RUN_CLASS_LABELS[runClass] ?? runClass;
}

/**
 * Where the calculator's actions-per-run ratio came from.
 *
 * Spelled out rather than shown as a raw enum: the contract's whole rationale
 * is that a hidden ratio is a quote a buyer cannot check, and "run_class" on
 * screen is barely less hidden than no ratio at all.
 */
export function actionsPerRunSourceLabel(
  source: "run_class" | "caller_supplied",
): string {
  return source === "caller_supplied"
    ? "your measured ratio"
    : "the published ratio for this run class";
}

/**
 * The share of the plan allowance consumed, as a 0–1 fraction.
 *
 * Returns null when the allowance is zero — a percentage of nothing is not 0%
 * and not 100%, it is undefined, and a progress bar at either end would be a
 * claim the data does not support.
 */
export function allowanceConsumedFraction(
  actionsUsed: number,
  actionsIncluded: number,
): number | null {
  if (!Number.isFinite(actionsIncluded) || actionsIncluded <= 0) return null;
  return Math.min(1, Math.max(0, actionsUsed / actionsIncluded));
}
