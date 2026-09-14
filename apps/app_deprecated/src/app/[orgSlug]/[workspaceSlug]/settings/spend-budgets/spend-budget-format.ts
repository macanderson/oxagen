/**
 * spend-budget-format.ts — pure formatting + validation helpers for the
 * Workspace → Settings → Spend Budgets panel.
 *
 * No "use client" — safe to import from the server page, the client panel,
 * or a unit test. `validateWindowDays` mirrors the DB CHECK / contract
 * refine in packages/oxagen/src/contracts/billing.budget.set.ts exactly, so
 * the user gets a clean client-side validation message instead of a
 * round-trip server error for the same rule.
 */
import type { SpendBudgetStatusDto } from "@oxagen/oxagen/contracts/billing.budget.get";
import type { Money } from "@oxagen/oxagen/money";

export type SpendBudgetPeriod = "monthly" | "rolling";
export type SpendBudgetScope = "org" | "workspace";
export type SpendBudgetState = SpendBudgetStatusDto["state"];

/** Shared client-facing shape — structurally identical to both
 *  get_spend_budget's per-entry DTO and set_spend_budget's single-status
 *  output, so one type serves both call sites. */
export type SpendBudgetStatus = SpendBudgetStatusDto;

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Plain USD number → "$1,234.56". Always uses Intl.NumberFormat — never
 *  hand-rolled string concatenation. */
export function formatUsd(amount: number): string {
  return USD_FORMATTER.format(amount);
}

/**
 * The wire carries money as integer micro-units in a decimal string
 * (`{ micros, currency }`, ADR-057 decision 2). This panel edits and shows
 * dollars, so the conversion happens once at this boundary and nowhere else
 * in the page.
 */
export function moneyToUsd(money: Money): number {
  return Number(money.micros) / 1_000_000;
}

/** Money → "$1,234.56". */
export function formatMoney(money: Money): string {
  return formatUsd(moneyToUsd(money));
}

/**
 * A dollar amount from the form → wire micros. The amount is rendered to six
 * decimals as a string and the point dropped, so `0.07` is exactly `70000`
 * micros and no float multiply rounds the value.
 */
export function usdToMoney(usd: number): Money {
  const micros = usd
    .toFixed(6)
    .replace(".", "")
    .replace(/^0+(?=\d)/, "");
  return { micros, currency: "USD" };
}

/**
 * Readable window label, e.g. "Jul 1 – Jul 21, 2026" (cross-year: "Dec 15,
 * 2025 – Jan 3, 2026"). windowEnd is documented as EXCLUSIVE / "now" for an
 * in-progress period, so it is rendered as-is — never shifted by a day.
 * Falls back to the raw ISO strings if either date fails to parse (never
 * throws — this renders inside a settings card).
 */
export function formatWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} – ${endIso}`;
  }
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const startFmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
  const endFmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${startFmt.format(start)} – ${endFmt.format(end)}`;
}

/**
 * Mirrors the DB CHECK / contract refine on set_spend_budget: `rolling`
 * requires a positive integer windowDays; `monthly` must not carry one.
 * Returns a user-facing error message, or null when valid.
 */
export function validateWindowDays(
  period: SpendBudgetPeriod,
  windowDays: number | null,
): string | null {
  if (period === "rolling") {
    if (windowDays == null || !Number.isFinite(windowDays) || windowDays <= 0) {
      return "Rolling window requires a whole number of days greater than 0.";
    }
    if (!Number.isInteger(windowDays)) {
      return "Rolling window days must be a whole number.";
    }
    return null;
  }
  return windowDays != null
    ? "Window days only applies to a rolling period."
    : null;
}

/** Mirrors the contract's positive-micros refine on `limit`, in dollars. */
export function validateLimitUsd(limitUsd: number | null): string | null {
  if (limitUsd == null || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    return "Limit must be a dollar amount greater than $0.";
  }
  return null;
}

export const STATE_META: Record<
  SpendBudgetState,
  {
    label: string;
    badgeVariant: "success-soft" | "warning-soft" | "error-soft";
  }
> = {
  ok: { label: "On track", badgeVariant: "success-soft" },
  threshold_50: { label: "50% reached", badgeVariant: "success-soft" },
  threshold_80: { label: "80% reached", badgeVariant: "warning-soft" },
  threshold_95: { label: "95% reached", badgeVariant: "warning-soft" },
  exceeded: { label: "Exceeded — runs denied", badgeVariant: "error-soft" },
};

export const SCOPE_LABEL: Record<SpendBudgetScope, string> = {
  org: "Organization",
  workspace: "Workspace",
};

export const SCOPE_DESCRIPTION: Record<SpendBudgetScope, string> = {
  org: "Covers every workspace in this organization.",
  workspace: "Covers this workspace only.",
};
