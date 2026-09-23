/**
 * The refusal a minted key gives when it has nothing left to spend (ADR-131
 * §3 and §9).
 *
 * Each key Oxagen mints carries a daily USD ceiling. When a turn crosses it,
 * OpenRouter answers 402 and the AI SDK surfaces that as an `APICallError`
 * whose message names the vendor and the key, neither of which the person
 * asking can act on. This module turns that answer into one named error with
 * a message the assistant can show and a `code` a surface can branch on.
 *
 * There is no fallback to the shared key here, on purpose. The ceiling exists
 * to bound what one organisation's turns can spend on the account every
 * other organisation depends on (ADR-131 §3). Moving a refused turn onto the
 * shared key would spend past that bound the moment it was reached, so the
 * key that hit its ceiling stays refused until the ceiling resets. The read
 * path (ADR-131 §6) falls back; the call path does not.
 *
 * A 402 also answers when the whole account is out of credit. The message
 * names both readings rather than guessing, and the log line carries the
 * vendor's text for the operator who can tell them apart.
 */
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import pino from "pino";

const logger = pino({ name: "ai.assistant-model-key" });

export const ASSISTANT_MODEL_KEY_LIMIT_CODE = "assistant_model_key_limit";

/** The vendor refused the organisation's minted key for spend. */
export class AssistantModelKeyLimitError extends Error {
  readonly code = ASSISTANT_MODEL_KEY_LIMIT_CODE;
  /** The last characters of the key, as the operator sees it in the list. */
  readonly keyHint: string | undefined;
  constructor(args: { keyHint?: string; cause?: unknown }) {
    super(
      "Model spend refused on this organisation's key. Its daily ceiling or " +
        "the account balance is exhausted. Retry after midnight UTC, or ask an " +
        "operator to raise the ceiling.",
      { cause: args.cause },
    );
    this.name = "AssistantModelKeyLimitError";
    this.keyHint = args.keyHint;
  }
}

/** True for the vendor's spend refusal, judged by status and not by text. */
export function isSpendRefusal(err: unknown): err is APICallError {
  return APICallError.isInstance(err) && err.statusCode === 402;
}

/**
 * Middleware for a model built on a minted key. A spend refusal from the
 * vendor becomes {@link AssistantModelKeyLimitError}; every other error
 * passes through untouched. The 402 arrives on the response headers, before
 * any stream part, so wrapping the two entry points covers both call shapes.
 */
export function mintedKeyLimitMiddleware(args: {
  orgId: string;
  keyHint?: string;
}): LanguageModelV4Middleware {
  const translate = (err: unknown): never => {
    if (!isSpendRefusal(err)) throw err;
    logger.error(
      {
        orgId: args.orgId,
        keyHint: args.keyHint,
        statusCode: err.statusCode,
        vendorMessage: err.responseBody?.slice(0, 500),
        alert: "assistant_model_key_limit",
      },
      "assistant-model-key: the vendor refused the organisation's minted key for spend; not falling back to the shared key (ADR-131 §3)",
    );
    throw new AssistantModelKeyLimitError({
      keyHint: args.keyHint,
      cause: err,
    });
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
