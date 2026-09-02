/**
 * Payload sizing/digest helpers shared by the subagent fanout read handlers
 * (docs/specs/graph-mediated-fanout). Dependency-free on purpose — safe to
 * import from any handler without pulling in drizzle/db modules.
 */

/** Matches the executor's summary budget and the CLI fleet's proven 280-char digest. */
export const RUN_SUMMARY_MAX_CHARS = 280;

/** Serialized byte size of a JSON payload; 0 when null/undefined or unserializable. */
export function payloadByteSize(v: unknown): number {
  if (v === null || v === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    return 0;
  }
}

/**
 * Fallback digest for run rows written before subagent_runs.summary existed
 * (or when the executor's write was lost). Mirrors the executor's
 * deriveRunSummary precedence: declared summary/message/text field → JSON
 * truncation → error reason.
 */
export function fallbackRunSummary(
  output: unknown,
  errorReason: string | null,
): string {
  if (
    output !== null &&
    output !== undefined &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const record = output as Record<string, unknown>;
    for (const key of ["summary", "message", "text"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, RUN_SUMMARY_MAX_CHARS);
      }
    }
  }
  if (output !== null && output !== undefined) {
    try {
      const serialized = JSON.stringify(output);
      if (typeof serialized === "string" && serialized.length > 0) {
        return serialized.slice(0, RUN_SUMMARY_MAX_CHARS);
      }
    } catch {
      // fall through to error reason
    }
  }
  return (errorReason ?? "").slice(0, RUN_SUMMARY_MAX_CHARS);
}

/**
 * Cap a payload at `capBytes` serialized bytes. Under the cap the payload
 * passes through untouched; over it, the value is replaced by its truncated
 * JSON string (structure is unavoidably lost — that is the signal to fetch
 * the full payload via agent.subagent.result.get).
 */
export function capPayload(
  v: unknown,
  capBytes: number,
): { value: unknown; truncated: boolean } {
  if (v === null || v === undefined) return { value: v, truncated: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch {
    return { value: null, truncated: true };
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).length <= capBytes
  ) {
    return { value: v, truncated: false };
  }
  return { value: `${serialized.slice(0, capBytes)}…`, truncated: true };
}
