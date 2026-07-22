/**
 * `oxagen budget …` — CLI parity surface for `get_spend_budget` /
 * `set_spend_budget` (Linear #1079). Reads and writes the hard period-to-date
 * spend ceilings that gate agent runs — the org-level ceiling (all
 * workspaces) and the active workspace's own ceiling — with their live burn:
 * period-to-date spend, projection to the period end, percent of ceiling, and
 * whether the gate is currently denying.
 *
 *   oxagen budget show                                     current ceilings + burn
 *   oxagen budget set --scope <org|workspace> --period <monthly|rolling>
 *                     --limit <usd> [--window-days <n>] [--enabled <bool>]
 *
 * Both calls go through the shared org-scoped API client in lib/api.ts. `show`
 * (GET /billing/budget) uses apiGetOrThrow; `set` (PUT /billing/budget, same
 * URL as the read — the route models "set" as a replace-in-place, not a
 * separate `.../set` POST) uses apiPutOrThrow. `set`'s scope/period/limit are
 * Commander-required; the rolling/monthly windowDays cross-field rule mirrors
 * the contract's zod `.refine()` client-side so a bad combination fails fast
 * (usage error, exit 2) without a wasted round trip — the kernel still
 * re-validates the same rule server-side regardless.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload as
 * one line on stdout; pretty mode renders a table; failures are uniform
 * stderr error lines (exit 2 for a bad flag, exit 1 for an API failure).
 */
import { apiGetOrThrow, apiPutOrThrow, printTable } from "../lib/api.js";
import { formatUsd } from "../agent/rate-card.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Output shapes (mirror the billing.budget.{get,set} contract output) ─────

export type SpendBudgetScope = "org" | "workspace";
export type SpendBudgetPeriod = "monthly" | "rolling";
export type SpendBudgetState =
  | "ok"
  | "threshold_50"
  | "threshold_80"
  | "threshold_95"
  | "exceeded";

export interface SpendBudgetStatus {
  scope: SpendBudgetScope;
  publicId: string | null;
  enabled: boolean;
  period: SpendBudgetPeriod;
  windowDays: number | null;
  limitUsd: number | null;
  spentUsd: number;
  projectedUsd: number;
  ratio: number;
  state: SpendBudgetState;
  reachedThreshold: number;
  windowStart: string;
  windowEnd: string;
}

interface SpendBudgetGetResult {
  budgets: SpendBudgetStatus[];
}

const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

const STATE_LABEL: Record<SpendBudgetState, string> = {
  ok: "ok",
  threshold_50: "50%+",
  threshold_80: "80%+",
  threshold_95: "95%+ (near limit)",
  exceeded: "EXCEEDED",
};

function periodCell(
  b: Pick<SpendBudgetStatus, "period" | "windowDays">,
): string {
  return b.period === "rolling" ? `rolling (${b.windowDays}d)` : "monthly";
}

function budgetRow(b: SpendBudgetStatus): string[] {
  return [
    b.scope,
    b.enabled ? "yes" : "no",
    periodCell(b),
    b.limitUsd == null ? "—" : formatUsd(b.limitUsd),
    formatUsd(b.spentUsd),
    formatUsd(b.projectedUsd),
    b.limitUsd == null ? "—" : pct(b.ratio),
    STATE_LABEL[b.state],
  ];
}

function renderBudgetsTable(
  budgets: SpendBudgetStatus[],
  writer: CommandWriter,
): void {
  printTable(
    [
      "SCOPE",
      "ENABLED",
      "PERIOD",
      "LIMIT",
      "SPENT",
      "PROJECTED",
      "% OF LIMIT",
      "STATE",
    ],
    budgets.map(budgetRow),
    writer,
  );
  const alerts = budgets.filter((b) => b.enabled && b.state !== "ok");
  if (alerts.length > 0) {
    writer.write("");
    for (const b of alerts) {
      writer.write(
        `⚠ ${b.scope} budget ${b.state === "exceeded" ? "has been exceeded" : `is at ${pct(b.ratio)} of its limit`} ` +
          `(${formatUsd(b.spentUsd)} of ${b.limitUsd == null ? "—" : formatUsd(b.limitUsd)}).`,
      );
    }
  }
}

// ── budget show ───────────────────────────────────────────────────────────

export async function budgetShow(
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: SpendBudgetGetResult;
  try {
    result = await apiGetOrThrow<SpendBudgetGetResult>("billing/budget");
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  if (result.budgets.length === 0) {
    writer.write(
      "No spend ceilings configured. Set one with:\n" +
        "  oxagen budget set --scope <org|workspace> --period <monthly|rolling> --limit <usd>",
    );
    return;
  }
  writer.write("Spend ceilings (period-to-date):");
  writer.write("");
  renderBudgetsTable(result.budgets, writer);
}

// ── budget set ────────────────────────────────────────────────────────────

export interface BudgetSetCliOptions {
  scope?: string;
  period?: string;
  limit?: string;
  windowDays?: string;
  enabled?: string;
  json?: boolean;
}

function isSpendScope(v: string): v is SpendBudgetScope {
  return v === "org" || v === "workspace";
}

function isSpendPeriod(v: string): v is SpendBudgetPeriod {
  return v === "monthly" || v === "rolling";
}

/** Parse a "true"/"false" (also "yes"/"no") flag value, or undefined if unrecognized. */
function parseBool(v: string): boolean | undefined {
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return undefined;
}

export async function budgetSet(
  opts: BudgetSetCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  if (!opts.scope || !isSpendScope(opts.scope)) {
    process.exitCode = 2;
    out.error(
      `Invalid --scope "${opts.scope ?? ""}". Use "org" or "workspace".`,
      "usage",
    );
    return;
  }
  if (!opts.period || !isSpendPeriod(opts.period)) {
    process.exitCode = 2;
    out.error(
      `Invalid --period "${opts.period ?? ""}". Use "monthly" or "rolling".`,
      "usage",
    );
    return;
  }
  const limitUsd = opts.limit === undefined ? NaN : Number(opts.limit);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    process.exitCode = 2;
    out.error(
      `Invalid --limit "${opts.limit ?? ""}". Provide a positive USD number.`,
      "usage",
    );
    return;
  }

  // Mirror the contract's cross-field refine: rolling requires a positive
  // integer windowDays; monthly must not carry one. Failing fast here (before
  // any network call) gives the same message the server would, for free.
  let windowDays: number | undefined;
  if (opts.period === "rolling") {
    const parsed =
      opts.windowDays === undefined ? NaN : Number(opts.windowDays);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      process.exitCode = 2;
      out.error(
        `--window-days is required (and > 0) for --period rolling. Got "${opts.windowDays ?? ""}".`,
        "usage",
      );
      return;
    }
    windowDays = parsed;
  } else if (opts.windowDays !== undefined) {
    process.exitCode = 2;
    out.error(`--window-days must be omitted for --period monthly.`, "usage");
    return;
  }

  const enabled = opts.enabled === undefined ? true : parseBool(opts.enabled);
  if (enabled === undefined) {
    process.exitCode = 2;
    out.error(
      `Invalid --enabled "${opts.enabled ?? ""}". Use "true" or "false".`,
      "usage",
    );
    return;
  }

  let result: SpendBudgetStatus;
  try {
    result = await apiPutOrThrow<SpendBudgetStatus>("billing/budget", {
      scope: opts.scope,
      enabled,
      period: opts.period,
      windowDays,
      limitUsd,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }

  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `✓ ${result.scope} spend ceiling set to ${formatUsd(limitUsd)} (${periodCell(result)}).`,
  );
  writer.write("");
  renderBudgetsTable([result], writer);
}
