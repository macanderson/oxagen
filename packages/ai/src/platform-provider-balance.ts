/**
 * The refusal Oxagen's own provider account gives when its balance runs out
 * (#5408).
 *
 * An organisation with no key of its own runs on the shared key in the
 * process environment: Oxagen's account with the model provider. When that
 * account's balance runs out, the provider answers 402 and the AI SDK surfaces
 * an `APICallError` whose text ("Insufficient credits. Add more using ...")
 * reads as the organisation's credits. It is not. The organisation's Oxagen
 * credits are a separate ledger, and only Oxagen can top up the provider
 * account. On 2026-10-03 that text reached 130 work items, and nothing told an
 * operator.
 *
 * This module turns the answer into one named error whose message says whose
 * balance ran out, and raises the alert. Every refusal writes an error-level
 * log line with the stable code `platform_provider_balance`. The first
 * refusal in each clock hour, across every process, also goes to
 * `captureError`: the ClickHouse error stream, and the alert webhook when
 * `ALERT_WEBHOOK_URL` is set. The hour is counted in
 * `ratelimit.rate_limit_counters`, the store the API's rate limiter uses.
 *
 * A key the organisation brought is not wrapped: its 402 is the customer's own
 * account. A minted key has its own middleware (assistant-model-key-limit.ts).
 */
import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import { schema, withSystemDb } from "@oxagen/database";
import { captureError, type CaptureErrorInput } from "@oxagen/telemetry";
import { sql } from "drizzle-orm";
import pino from "pino";
import { isSpendRefusal } from "./assistant-model-key-limit";
import { parseOutputBudgetRefusal } from "./output-budget";

const logger = pino({ name: "ai.platform-provider-balance" });

/** The stable code on the error, the log line, and a work item's failure fact. */
export const PLATFORM_PROVIDER_BALANCE_CODE = "platform_provider_balance";

/** One alert per window while the refusals continue. */
export const PLATFORM_PROVIDER_BALANCE_ALERT_WINDOW_MS = 60 * 60 * 1000;

/** The counter row's key. It names no tenant: the account is Oxagen's. */
const ALERT_BUCKET = "alert:platform_provider_balance";

/** Oxagen's provider account refused a call on the shared key for lack of balance. */
export class PlatformProviderBalanceError extends Error {
  readonly code = PLATFORM_PROVIDER_BALANCE_CODE;
  constructor(cause?: unknown) {
    super(
      "Oxagen's account with its model provider is out of balance, so the " +
        "provider refused the call. This is Oxagen's to fix. Your " +
        "organization's credits are not affected.",
      { cause },
    );
    this.name = "PlatformProviderBalanceError";
  }
}

/** True for {@link PlatformProviderBalanceError}, judged by its code so a second copy of this module still matches. */
export function isPlatformProviderBalanceError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === PLATFORM_PROVIDER_BALANCE_CODE
  );
}

/** What the alert needs. Tests pass fakes. */
export interface PlatformBalanceAlertDeps {
  /** True when this is the first refusal in the window that starts at `windowStart`, across every process. */
  firstInWindow(windowStart: Date): Promise<boolean>;
  capture(input: CaptureErrorInput): void;
}

async function firstInWindow(windowStart: Date): Promise<boolean> {
  const counters = schema.rateLimitCounters;
  // tenancy: global alert counter with no org_id; the bucket key names Oxagen's own provider account, never a tenant.
  const rows = await withSystemDb((tx) =>
    tx
      .insert(counters)
      .values({ bucketKey: ALERT_BUCKET, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [counters.bucketKey, counters.windowStart],
        set: { count: sql`${counters.count} + 1` },
      })
      .returning({ count: counters.count }),
  );
  return rows[0]?.count === 1;
}

const defaultDeps: PlatformBalanceAlertDeps = {
  firstInWindow,
  capture: captureError,
};

/**
 * The last window this process asked the counter about. Once it has asked,
 * the rest of the hour's refusals here skip the database.
 */
let checkedWindow: number | null = null;

/** Test seam: forget the window this process already checked. */
export function resetPlatformBalanceAlertForTests(): void {
  checkedWindow = null;
}

/**
 * Log one refusal at error level, and raise the alert when it is the first in
 * its hour. A counter that cannot be read raises the alert: a second alert is
 * better than none. Never throws.
 */
export async function reportPlatformProviderBalance(
  refusal: { orgId: string; statusCode: number; vendorMessage?: string },
  now: Date = new Date(),
  deps: PlatformBalanceAlertDeps = defaultDeps,
): Promise<void> {
  logger.error(
    {
      code: PLATFORM_PROVIDER_BALANCE_CODE,
      alert: PLATFORM_PROVIDER_BALANCE_CODE,
      orgId: refusal.orgId,
      statusCode: refusal.statusCode,
      vendorMessage: refusal.vendorMessage?.slice(0, 500),
    },
    "platform-provider-balance: the model provider refused Oxagen's shared key for lack of balance; top up the provider account",
  );
  const window = Math.floor(
    now.getTime() / PLATFORM_PROVIDER_BALANCE_ALERT_WINDOW_MS,
  );
  if (checkedWindow === window) return;
  checkedWindow = window;
  let first = true;
  try {
    first = await deps.firstInWindow(
      new Date(window * PLATFORM_PROVIDER_BALANCE_ALERT_WINDOW_MS),
    );
  } catch (err) {
    logger.warn(
      { err, code: PLATFORM_PROVIDER_BALANCE_CODE },
      "platform-provider-balance: the alert counter did not read, so this process raises the alert itself",
    );
  }
  if (!first) return;
  deps.capture({
    error: new PlatformProviderBalanceError(),
    source: "api",
    severity: "error",
    orgId: refusal.orgId,
    context: `${PLATFORM_PROVIDER_BALANCE_CODE}: the model provider answered ${String(refusal.statusCode)} on Oxagen's shared key. Top up the provider account. Every platform-funded model call fails until then`,
  });
}

/**
 * Middleware for a model built on the shared key. A spend refusal becomes
 * {@link PlatformProviderBalanceError}, and every other error passes through
 * untouched. A refusal that names the ceiling the balance can afford passes
 * through too, so `withOutputBudgetRetry` can ask again at that number (#2629).
 */
export function platformKeyBalanceMiddleware(args: {
  orgId: string;
  report?: typeof reportPlatformProviderBalance;
}): LanguageModelV4Middleware {
  const report = args.report ?? reportPlatformProviderBalance;
  const translate = async (err: unknown): Promise<never> => {
    if (!isSpendRefusal(err) || parseOutputBudgetRefusal(err) !== null)
      throw err;
    await report({
      orgId: args.orgId,
      statusCode: err.statusCode ?? 402,
      vendorMessage: err.responseBody ?? err.message,
    });
    throw new PlatformProviderBalanceError(err);
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      try {
        return await doGenerate();
      } catch (err) {
        return translate(err);
      }
    },
    wrapStream: async ({ doStream }) => {
      try {
        return await doStream();
      } catch (err) {
        return translate(err);
      }
    },
  };
}
