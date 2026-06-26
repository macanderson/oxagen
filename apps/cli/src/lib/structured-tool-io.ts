/**
 * Structured tool I/O — wraps tool execution results into indexed,
 * retrievable records instead of raw text pasted into context.
 *
 * Every tool result is:
 * 1. Summarized to a one-line reference
 * 2. Written to Engram as an episodic record
 * 3. Available for recall via its record handle
 */

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
    /** Engram record ID for page-back-in. */
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

function isErrorResult(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === "object" && "error" in result) return true;
  if (result instanceof Error) return true;
  return false;
}

function estimateTokens(result: unknown): number {
  const str = typeof result === "string" ? result : JSON.stringify(result ?? {});
  return Math.max(1, Math.ceil(str.length / 4));
}
