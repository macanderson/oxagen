/**
 * Concrete shapes for the `fullStream` parts we process. We iterate
 * `result.fullStream as AsyncIterable<unknown>` and type-narrow each part via
 * `partType()` rather than relying on the SDK's `TextStreamPart<ToolSet>`
 * generic, which does not resolve the `tool-result` arm to a concrete
 * narrowable shape when TOOLS is the wide `ToolSet` alias.
 */
export interface TextDeltaPart {
  type: "text-delta";
  text: string;
}
export interface ReasoningDeltaPart {
  type: "reasoning-delta";
  id: string;
  text: string;
}
export interface ReasoningBoundaryPart {
  type: "reasoning-start" | "reasoning-end";
  id: string;
}
export interface ToolInputStartPart {
  type: "tool-input-start";
  id: string;
  toolName: string;
}
export interface ToolInputDeltaPart {
  type: "tool-input-delta";
  id: string;
  delta: string;
}
export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}
export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
}
export interface ToolErrorPart {
  type: "tool-error";
  toolCallId: string;
  toolName: string;
  error: unknown;
}
export interface FinishPart {
  type: "finish";
  totalUsage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/** Discriminant accessor for an unknown stream part. */
export function partType(p: unknown): string | undefined {
  return typeof p === "object" && p !== null && "type" in p
    ? String((p as { type: unknown }).type)
    : undefined;
}

/** Narrow an unknown value to a plain record. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Normalize any thrown/streamed error value into a human string. */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Tool execution failed";
}

/**
 * A turn-level failure reduced to display fields: a human-readable `message`
 * and an optional machine `code` (e.g. "insufficient_credits"). The chat UI
 * surfaces this as a toast — never inline assistant text.
 */
export interface StreamErrorInfo {
  code?: string;
  message: string;
}

/**
 * Parse an arbitrary thrown/streamed error value into a clean {code, message}.
 *
 * Turn failures reach us in several shapes: a thrown `Error` whose `.message`
 * is a stringified API error envelope (`{"error":{"code","message"},"requestId"}`
 * — exactly what apps/api's error middleware emits on a 402/4xx), a raw envelope
 * string, a plain prose string, or an `Error` with a prose message. Whatever the
 * shape, callers get a code+message they can render as a toast instead of dumping
 * raw JSON onto the page. Always returns a non-empty `message`.
 */
const GENERIC_STREAM_ERROR = "Something went wrong. Please try again.";

export function formatStreamError(value: unknown): StreamErrorInfo {
  // Unwrap an Error to its message string first — envelopes usually arrive that
  // way (a fetch failure stringifies the response body into the Error message).
  const candidate = value instanceof Error ? value.message : value;

  // If `candidate` is (or stringifies to) a JSON object, it's structured data —
  // either an envelope we can extract a message from, or one we can't. Either
  // way we must NOT echo the raw JSON back as the message; that is exactly the
  // raw-JSON-on-the-page bug this helper exists to prevent.
  const record = toRecord(candidate);
  if (record !== null) {
    const info = infoFromRecord(record);
    return info ?? { message: GENERIC_STREAM_ERROR };
  }

  // Plain prose — the candidate string (or the Error's message) is the message.
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return { message: candidate };
  }
  if (value instanceof Error && value.message.trim().length > 0) {
    return { message: value.message };
  }
  return { message: GENERIC_STREAM_ERROR };
}

/**
 * Resolve a value to a plain record if it is one, or if it is a JSON string
 * that parses to one. Returns null for prose strings, malformed JSON, arrays,
 * and primitives so the caller treats them as plain messages.
 */
function toRecord(candidate: unknown): Record<string, unknown> | null {
  if (isRecord(candidate)) return candidate;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    // Only attempt a parse when it actually looks like an object literal; a
    // prose message like "Gateway timeout" must pass through untouched.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    try {
      const json: unknown = JSON.parse(trimmed);
      return isRecord(json) ? json : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Pull {code, message} out of a structured error record. Returns null when the
 * record carries no usable (non-blank) message in any recognized shape.
 */
function infoFromRecord(
  record: Record<string, unknown>,
): StreamErrorInfo | null {
  // Envelope form: { error: { code?, message }, requestId? }.
  const errField = record["error"];
  if (isRecord(errField)) {
    const message =
      typeof errField["message"] === "string" ? errField["message"] : undefined;
    const code =
      typeof errField["code"] === "string" ? errField["code"] : undefined;
    if (message !== undefined && message.trim().length > 0) {
      return code !== undefined ? { code, message } : { message };
    }
  }
  // Envelope where `error` is itself the message string.
  if (typeof errField === "string" && errField.trim().length > 0) {
    return { message: errField };
  }
  // Flat form: { message, code? }.
  const flatMessage = record["message"];
  if (typeof flatMessage === "string" && flatMessage.trim().length > 0) {
    const code =
      typeof record["code"] === "string" ? record["code"] : undefined;
    return code !== undefined
      ? { code, message: flatMessage }
      : { message: flatMessage };
  }
  return null;
}
