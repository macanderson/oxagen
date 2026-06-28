/**
 * Structured tool I/O — wraps tool execution results into indexed,
 * retrievable records instead of raw text pasted into context.
 *
 * Every tool result is:
 * 1. Summarized to a one-line reference
 * 2. Written to the context store as an episodic record
 * 3. Available for recall via its record handle
 */
import { z } from "zod";

export interface StructuredToolResult {
  /** Tool that was executed. */
  toolName: string;
  /** Whether execution succeeded. */
  success: boolean;
  /** One-line summary for context (≤100 chars). */
  summary: string;
  /** Full result payload. */
  data: unknown;
  metadata: {
    executionMs: number;
    /** Estimated tokens if the full result were included verbatim. */
    tokenEstimate: number;
    /** Context store record ID for page-back-in. */
    recordHandle?: string;
  };
}

/**
 * Create a structured result from raw tool output.
 */
export function structureToolResult(
  toolName: string,
  rawResult: unknown,
  executionMs: number,
): StructuredToolResult {
  const success = !isErrorResult(rawResult);
  const summary = generateSummary(toolName, rawResult, success);
  const data = rawResult;
  const tokenEstimate = estimateTokens(rawResult);

  return {
    toolName,
    success,
    summary,
    data,
    metadata: { executionMs, tokenEstimate },
  };
}

/**
 * Generate a one-line summary from a tool result.
 */
function generateSummary(toolName: string, result: unknown, success: boolean): string {
  const status = success ? "ok" : "error";

  if (typeof result === "string") {
    return `${toolName} [${status}]: ${result.slice(0, 80)}`;
  }

  if (result && typeof result === "object") {
    const keys = Object.keys(result);
    if (keys.length <= 3) {
      return `${toolName} [${status}]: {${keys.join(", ")}}`;
    }
    return `${toolName} [${status}]: ${keys.length} fields`;
  }

  return `${toolName} [${status}]`;
}

/**
 * Did a tool result represent an error? Mirrors the canonical heuristic in
 * `agent/loop.ts` (kept in sync deliberately): an Error instance, an explicit
 * `isError === true`, or a *present and truthy* `error` field. The earlier
 * version here used `"error" in result`, which mis-classified a successful
 * `{ error: null }` (or `{ error: false }`) as a failure and missed the
 * `{ isError: true }` convention entirely.
 */
function isErrorResult(result: unknown): boolean {
  if (result instanceof Error) return true;
  if (result && typeof result === "object") {
    const o = result as { isError?: unknown; error?: unknown };
    if (o.isError === true) return true;
    if (o.error != null && o.error !== false) return true;
  }
  return false;
}

/**
 * Zod schema for a {@link StructuredToolResult}. Use {@link parseStructuredToolResult}
 * to validate a record that crossed a trust boundary (IPC / daemon / disk)
 * before treating it as structured output, rather than casting blindly.
 */
export const structuredToolResultSchema = z.object({
  toolName: z.string(),
  success: z.boolean(),
  summary: z.string(),
  data: z.unknown(),
  metadata: z.object({
    executionMs: z.number(),
    tokenEstimate: z.number(),
    recordHandle: z.string().optional(),
  }),
});

/** Validate an untrusted value as a StructuredToolResult; null if it doesn't conform. */
export function parseStructuredToolResult(
  value: unknown,
): StructuredToolResult | null {
  const parsed = structuredToolResultSchema.safeParse(value);
  return parsed.success ? (parsed.data as StructuredToolResult) : null;
}

function estimateTokens(result: unknown): number {
  const str = typeof result === "string" ? result : JSON.stringify(result ?? {});
  return Math.max(1, Math.ceil(str.length / 4));
}
