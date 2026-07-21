/**
 * spend-budget-gate.ts — the kernel admission gate for the hard period-to-date
 * spend ceiling (OXA-1079). `assertWithinSpendBudget` is injected into the
 * kernel via setBudgetAdmissionGate (bootstrapBillingRuntime) and runs on EVERY
 * scoped, metered invoke() — so it must be cheap. Two short-TTL caches (budget
 * config + ClickHouse spend, both keyed by scope) keep the steady-state guard a
 * sub-millisecond map read; a stubbed-reader timing test asserts the cached path
 * adds <5ms. The gate FAILS OPEN on any DB/telemetry error — a degraded store
 * must never block every invocation — but a real ceiling breach throws
 * BudgetExceededError (a DENY, mapped to 402 at the surfaces).
 *
 * Soft thresholds (50/80/95%) emit an in-app notification to org admins once per
 * threshold per period (deduped by a conditional watermark UPDATE); 100% is the
 * hard stop where the gate denies. Raising the ceiling (set_spend_budget) is the
 * IAM-gated, audited override.
 */
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import { sumSpendMicros } from "@oxagen/telemetry";
import {
  BudgetExceededError,
  evaluateSpendBudget,
  reachedSpendThreshold,
  spendBudgetWindow,
  type SpendBudgetVerdict,
} from "./spend-budget";
import {
  claimBudgetThreshold,
  getScopeBudgets,
  type SpendBudgetRow,
} from "./spend-budget-store";
import { logger } from "./logger";

// ── Injectable dependencies (production defaults; tests override) ─────────────

export interface SpendGateDeps {
  /** Load every enabled ceiling applicable to the active scope (org + workspace). */
  loadBudgets: () => Promise<SpendBudgetRow[]>;
  /** Sum period-to-date spend (micro-USD) for a scope window. */
  readSpend: (args: {
    orgId: string;
    workspaceId: string | null;
    periodStart: Date;
    periodEnd: Date;
  }) => Promise<bigint>;
  /** Wall clock (ms). Injected so the pure window math is testable. */
  now: () => number;
  /** Atomically claim the "notify once per threshold per period" watermark;
   *  true when THIS caller won the flip and should deliver the notification. */
  claimThreshold: (args: {
    budgetId: string;
    threshold: number;
    periodStart: Date;
  }) => Promise<boolean>;
  /** Deliver a threshold notification (fire-and-forget; must never throw into the gate). */
  notify: (args: BudgetThresholdNotice) => void;
  ttlConfigMs: number;
  ttlSpendMs: number;
}

export interface BudgetThresholdNotice {
  budget: SpendBudgetRow;
  verdict: SpendBudgetVerdict;
  threshold: number;
}

const DEFAULT_TTL_CONFIG_MS = 30_000;
const DEFAULT_TTL_SPEND_MS = 15_000;

const productionDeps: SpendGateDeps = {
  loadBudgets: getScopeBudgets,
  readSpend: sumSpendMicros,
  now: () => Date.now(),
  claimThreshold: claimBudgetThreshold,
  notify: (notice) => {
    // Fire-and-forget: a notification failure must never fail (or slow) the gate.
    void deliverBudgetThresholdNotification(notice).catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "billing: spend-budget threshold notification failed",
      );
    });
  },
  ttlConfigMs: DEFAULT_TTL_CONFIG_MS,
  ttlSpendMs: DEFAULT_TTL_SPEND_MS,
};

// ── Scope-keyed caches ────────────────────────────────────────────────────────
// Keyed by scope (org+workspace) so the window's moving end never invalidates
// the entry — the cached spend is refreshed on TTL, and the window is recomputed
// from `now` on each refresh. Module-level so the cache is shared across every
// invoke() in the process.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const configCache = new Map<string, CacheEntry<SpendBudgetRow[]>>();
const spendCache = new Map<string, CacheEntry<bigint>>();

/** Test-only: drop both caches so a timing/behaviour test starts cold. */
export function clearSpendBudgetCaches(): void {
  configCache.clear();
  spendCache.clear();
}

function scopeKey(orgId: string, workspaceId: string): string {
  return `${orgId}:${workspaceId}`;
}

async function cachedBudgets(
  key: string,
  deps: SpendGateDeps,
): Promise<SpendBudgetRow[]> {
  const nowMs = deps.now();
  const hit = configCache.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.value;
  const value = await deps.loadBudgets();
  configCache.set(key, { value, expiresAt: nowMs + deps.ttlConfigMs });
  return value;
}

async function cachedSpend(
  budget: SpendBudgetRow,
  window: { start: Date; end: Date },
  deps: SpendGateDeps,
): Promise<bigint> {
  const nowMs = deps.now();
  // The key omits the window end (which moves every call) so entries survive TTL;
  // include the period signature so a config change to period/windowDays misses.
  const key = `${budget.orgId}:${budget.workspaceId ?? "*"}:${budget.period}:${budget.windowDays ?? ""}`;
  const hit = spendCache.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.value;
  const value = await deps.readSpend({
    orgId: budget.orgId,
    workspaceId: budget.workspaceId,
    periodStart: window.start,
    periodEnd: window.end,
  });
  spendCache.set(key, { value, expiresAt: nowMs + deps.ttlSpendMs });
  return value;
}

/**
 * The notification anchor identifying the current "period" for dedup. For
 * monthly this is the calendar-month start (a crossing notifies once that
 * month). For rolling the window slides continuously, so we anchor to the start
 * of the current UTC day — a crossing re-notifies at most once per day rather
 * than on every call.
 */
function notifyAnchor(budget: SpendBudgetRow, now: Date): Date {
  if (budget.period === "monthly") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
  }
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

/**
 * The kernel budget gate. Evaluates every enabled ceiling applicable to the
 * scope (org-level first, then workspace-level) and throws BudgetExceededError
 * for the first whose period-to-date spend has REACHED its ceiling. Emits soft
 * threshold notifications along the way. Fails OPEN on any infrastructure error.
 */
export async function assertWithinSpendBudget(
  args: { orgId: string; workspaceId: string; capability: string },
  overrides: Partial<SpendGateDeps> = {},
): Promise<void> {
  const deps: SpendGateDeps = { ...productionDeps, ...overrides };
  let budgets: SpendBudgetRow[];
  try {
    budgets = await cachedBudgets(scopeKey(args.orgId, args.workspaceId), deps);
  } catch (err) {
    // A budget-config read failure must never block a turn — fail open.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), ...args },
      "billing: spend-budget gate — config load failed, failing open",
    );
    return;
  }
  if (budgets.length === 0) return; // no ceilings configured — nothing to gate.

  const now = new Date(deps.now());
  for (const budget of budgets) {
    let verdict: SpendBudgetVerdict;
    try {
      const window = spendBudgetWindow(budget.period, budget.windowDays, now);
      const spentMicros = await cachedSpend(budget, window, deps);
      verdict = evaluateSpendBudget({
        spentMicros,
        limitMicros: budget.limitMicros,
      });
    } catch (err) {
      // A spend read failure (ClickHouse down) must never block a turn — fail
      // open for THIS budget and continue to the next.
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          budgetId: budget.id,
        },
        "billing: spend-budget gate — spend read failed, failing open",
      );
      continue;
    }

    // Soft/hard threshold notification (fire-and-forget, deduped once per period).
    const threshold = verdict.reachedThreshold;
    if (threshold > 0) {
      const anchor = notifyAnchor(budget, now);
      void deps
        .claimThreshold({
          budgetId: budget.id,
          threshold,
          periodStart: anchor,
        })
        .then((won) => {
          if (won) deps.notify({ budget, verdict, threshold });
        })
        .catch(() => {
          /* watermark claim is best-effort — never fail the gate. */
        });
    }

    // Hard stop at 100% — DENY before this invocation's provider cost is incurred.
    if (verdict.overLimit) {
      throw new BudgetExceededError({
        scope: budget.scope,
        orgId: budget.orgId,
        workspaceId: budget.workspaceId,
        period: budget.period,
        limitMicros: budget.limitMicros,
        spentMicros: verdict.spentMicros,
        capability: args.capability,
      });
    }
  }
}

/**
 * Deliver a spend-budget threshold notification to every org admin (Owner /
 * Admin / Billing). Runs inside the caller's tenant scope. Best-effort — the
 * caller invokes it fire-and-forget and swallows failures.
 */
async function deliverBudgetThresholdNotification(
  notice: BudgetThresholdNotice,
): Promise<void> {
  const { budget, threshold, verdict } = notice;
  const admins = await withTenantDb((tx) =>
    tx
      .select({ userId: schema.orgUsers.userId })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, budget.orgId),
          sql`lower(${schema.orgUsers.role}) IN ('owner','admin','billing')`,
        ),
      ),
  );
  if (admins.length === 0) return;

  const scopeLabel = budget.scope === "org" ? "organization" : "workspace";
  const isHardStop = threshold >= 100;
  const pct = Math.round(verdict.ratio * 100);
  const title = isHardStop
    ? `Spend budget reached for this ${scopeLabel}`
    : `Spend budget at ${threshold}% for this ${scopeLabel}`;
  const body = isHardStop
    ? `The ${budget.period} spend ceiling has been reached (${pct}% of the limit). ` +
      `New metered agent runs are being denied until the budget is raised or the period resets.`
    : `The ${budget.period} spend has reached ${pct}% of the ceiling. Review usage in Billing → Budgets.`;

  await withTenantDb((tx) =>
    tx.insert(schema.notifications).values(
      admins.map((a) => ({
        orgId: budget.orgId,
        workspaceId: budget.workspaceId,
        userId: a.userId,
        kind: "security" as const,
        title,
        body,
        deepLink: "/settings/billing/budgets",
      })),
    ),
  );
}

// ── Panel status (burn + projection) ──────────────────────────────────────────

export interface SpendBudgetStatus {
  budget: SpendBudgetRow;
  spentMicros: bigint;
  ratio: number;
  state: SpendBudgetVerdict["state"];
  overLimit: boolean;
  reachedThreshold: number;
  window: { start: string; end: string };
  /** Linear month-to-date projection to the period end (monthly only; equals
   *  spent for a rolling window, which is already a full window). */
  projectedMicros: bigint;
}

/**
 * Live status for every configured ceiling in the active scope — the app
 * Budgets panel's data. Reads spend FRESH (bypasses the gate's short-TTL cache)
 * so the panel is accurate, not up-to-15s stale. Never throws: a spend-read
 * failure yields a status with spentMicros = 0 and state 'ok' so the panel still
 * renders the configured ceiling.
 */
export async function getSpendBudgetStatuses(
  overrides: Partial<
    Pick<SpendGateDeps, "loadBudgets" | "readSpend" | "now">
  > = {},
): Promise<SpendBudgetStatus[]> {
  const loadBudgets = overrides.loadBudgets ?? getScopeBudgets;
  const readSpend = overrides.readSpend ?? sumSpendMicros;
  const now = new Date((overrides.now ?? (() => Date.now()))());

  const budgets = await loadBudgets();
  const statuses: SpendBudgetStatus[] = [];
  for (const budget of budgets) {
    const window = spendBudgetWindow(budget.period, budget.windowDays, now);
    let spentMicros = 0n;
    try {
      spentMicros = await readSpend({
        orgId: budget.orgId,
        workspaceId: budget.workspaceId,
        periodStart: window.start,
        periodEnd: window.end,
      });
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          budgetId: budget.id,
        },
        "billing: getSpendBudgetStatuses — spend read failed, reporting 0",
      );
    }
    const verdict = evaluateSpendBudget({
      spentMicros,
      limitMicros: budget.limitMicros,
    });
    statuses.push({
      budget,
      spentMicros,
      ratio: verdict.ratio,
      state: verdict.state,
      overLimit: verdict.overLimit,
      reachedThreshold: reachedSpendThreshold(verdict.ratio),
      window: {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
      },
      projectedMicros: projectSpend(budget, window, spentMicros, now),
    });
  }
  return statuses;
}

/** Linear projection of monthly spend to the month end; rolling ⇒ spent as-is. */
function projectSpend(
  budget: SpendBudgetRow,
  window: { start: Date; end: Date },
  spentMicros: bigint,
  now: Date,
): bigint {
  if (budget.period !== "monthly") return spentMicros;
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = now.getTime() - window.start.getTime();
  const total = monthEnd - window.start.getTime();
  if (elapsed <= 0) return spentMicros;
  const projected = (Number(spentMicros) * total) / elapsed;
  return BigInt(Math.round(projected));
}
