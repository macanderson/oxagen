/**
 * The gateway refuses a request whose output CEILING it cannot fund, before it
 * writes a word — and this is how we ask again for what the balance covers.
 *
 * OpenRouter checks the balance against `max_tokens`, the most the reply could
 * possibly use, rather than against what the reply will actually cost. On a low
 * balance it refuses up front:
 *
 * ```
 * This request requires more credits, or fewer max_tokens. You requested up to
 * 8192 tokens, but can only afford 2048.
 * ```
 *
 * The refusal names the number it can afford, so it is answerable rather than
 * fatal: ask again with that ceiling. A balance that cannot fund the ceiling
 * usually can fund the reply, because the reply is far shorter than the ceiling
 * — that gap is the whole reason the refusal happens (#2629).
 *
 * Nothing used to catch it. Two files already described the hazard in comments
 * and then set a large ceiling anyway, and the error reached the user verbatim.
 * It is not hypothetical: it took the Connect-a-source wizard's nightly e2e run
 * down three times on 2026-09-02, on the same commit that had passed the night
 * before — only the CI account's balance had changed.
 *
 * **Which providers need this.** All of them, and none of them individually. The
 * check belongs to the GATEWAY, not the vendor: `models.ts` routes every model
 * through `@ai-sdk/gateway`, so the credit refusal happens before the request
 * reaches Anthropic, OpenAI, Google or any other vendor in the catalog. That is
 * why this is one gateway-level module rather than a row per vendor in
 * `provider-posture.ts` — a per-vendor matrix would carry eight identical rows
 * describing something no vendor does. (Stella records the same behaviour as an
 * `OutputBudgetPosture` per provider because it calls providers directly; here
 * there is one caller in front of all of them.)
 */

/** Stable code for the failure a caller can render as "your balance is low". */
export const OUTPUT_BUDGET_CODE = "OUTPUT_BUDGET_EXCEEDED" as const;

/**
 * The balance could not fund the request, and asking for the affordable ceiling
 * did not rescue it either.
 *
 * Carries the two numbers out of the refusal so a caller can say how short the
 * balance is rather than showing a provider string.
 */
export class OutputBudgetError extends Error {
  readonly code = OUTPUT_BUDGET_CODE;
  /** Tokens the account can fund, as the gateway reported them. */
  readonly affordableTokens: number | null;
  /** Ceiling that was asked for, when the refusal named one. */
  readonly requestedTokens: number | null;

  constructor(
    message: string,
    details: {
      affordableTokens: number | null;
      requestedTokens: number | null;
      cause?: unknown;
    },
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : {});
    this.name = "OutputBudgetError";
    this.affordableTokens = details.affordableTokens;
    this.requestedTokens = details.requestedTokens;
  }
}

/** Type guard for the failure, for callers that would rather not import the class. */
export function isOutputBudgetError(err: unknown): err is OutputBudgetError {
  return err instanceof OutputBudgetError;
}

/** What a credit refusal told us. */
export interface OutputBudgetRefusal {
  /** Tokens the account can fund. Always present — it is what makes a retry possible. */
  affordableTokens: number;
  /** Ceiling the refused request asked for, when the message named one. */
  requestedTokens: number | null;
}

/**
 * Two independent markers, both required, because the numbers alone are far too
 * common in provider errors to key on. `can only afford` is the phrase that
 * makes the refusal answerable; `more credits` is the one that identifies it as
 * a balance problem rather than a model limit.
 */
const AFFORDABLE = /can only afford\s+([\d,_]+)/i;
const REQUESTED = /requested up to\s+([\d,_]+)\s+tokens?/i;
const CREDIT_REFUSAL = /more credits|can only afford/i;

function toCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.replace(/[,_]/g, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Flatten an error to the text the gateway put in it. */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const cause = err.cause;
    const causeText =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "";
    // The SDK wraps the provider's body in a cause often enough that reading
    // only the outer message misses the numbers entirely.
    return `${err.message}\n${causeText}`;
  }
  return "";
}

/**
 * Read a credit refusal out of an error, or `null` when it is not one.
 *
 * `null` for anything unrecognised is the important half: an error this cannot
 * parse must reach the caller untouched, never be retried on a guess.
 */
export function parseOutputBudgetRefusal(
  err: unknown,
): OutputBudgetRefusal | null {
  const text = messageOf(err);
  if (!CREDIT_REFUSAL.test(text)) return null;

  const affordable = toCount(AFFORDABLE.exec(text)?.[1]);
  // Without a number there is nothing to retry WITH, so this is not actionable
  // and the original error is the honest thing to surface.
  if (affordable === null || affordable <= 0) return null;

  return {
    affordableTokens: affordable,
    requestedTokens: toCount(REQUESTED.exec(text)?.[1]),
  };
}

/**
 * Run `attempt`, and on a credit refusal run it once more with the ceiling the
 * gateway said it could afford.
 *
 * Exactly once. A second refusal is not retried again — the balance is genuinely
 * too low, and retrying without a limit is how a paid API turns a low balance
 * into a spend loop. Both failures surface as {@link OutputBudgetError} with the
 * numbers attached, so the UI can say the balance is short instead of showing a
 * provider string; anything that is not a credit refusal propagates untouched.
 */
export async function withOutputBudgetRetry<T>(
  attempt: (maxOutputTokens: number | undefined) => Promise<T>,
  requestedMaxOutputTokens: number | undefined,
): Promise<T> {
  try {
    return await attempt(requestedMaxOutputTokens);
  } catch (err) {
    const refusal = parseOutputBudgetRefusal(err);
    if (refusal === null) throw err;

    try {
      return await attempt(refusal.affordableTokens);
    } catch (retryErr) {
      const second = parseOutputBudgetRefusal(retryErr);
      throw new OutputBudgetError(
        `The account balance cannot fund this request. The gateway could afford ` +
          `${second?.affordableTokens ?? refusal.affordableTokens} output tokens; ` +
          `retrying at that ceiling failed too. Add credits and try again.`,
        {
          affordableTokens:
            second?.affordableTokens ?? refusal.affordableTokens,
          requestedTokens:
            refusal.requestedTokens ?? requestedMaxOutputTokens ?? null,
          cause: retryErr,
        },
      );
    }
  }
}
