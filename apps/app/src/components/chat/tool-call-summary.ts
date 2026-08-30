/**
 * tool-call-summary — extracts a short, human one-liner from a tool call's
 * input so the compact activity row can show WHAT a call is doing without
 * expanding the full structured tree. A `search_web` call whose input is
 * `{ query: "tide tables for Monterey" }` summarises as that query string.
 *
 * We pick the most salient string field in a fixed priority order, preferring
 * the fields a human reads first (a query, a name, a path) and falling back to
 * an id only as a last resort. Anything else returns null — the caller then
 * shows only the human label, never raw JSON.
 */

// Salient string keys, highest priority first. Matched case-insensitively
// against the input's own keys. `capability` is accepted for future
// per-capability tuning; today the extraction is capability-agnostic.
const PRIORITY_KEYS = [
  "query",
  "q",
  "search",
  "prompt",
  "name",
  "title",
  "path",
  "file",
  "url",
] as const;

const MAX_LEN = 64;

/** An id-ish key: bare `id`, camelCase `…Id`, or snake `…_id`. Kept strict so
 *  plain words ending in "id" (valid, grid) are not treated as ids. */
function isIdKey(key: string): boolean {
  return /^id$/i.test(key) || /Id$/.test(key) || /_id$/i.test(key);
}

/** Collapse whitespace to single spaces and clip to a single line ~MAX_LEN. */
function tidy(value: string): string | null {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.length > MAX_LEN
    ? `${oneLine.slice(0, MAX_LEN - 1).trimEnd()}…`
    : oneLine;
}

/** Pull the most salient string value out of an arbitrary tool input. */
function extractSalient(input: unknown): string | null {
  if (typeof input === "string") {
    const trimmed = input.trim();
    // An unparsed partial-JSON blob (still-streaming args) is not human text.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
    return trimmed.length > 0 ? trimmed : null;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  // Lower-cased lookup so the priority match is case-insensitive.
  const byLower = new Map<string, unknown>();
  for (const [key, val] of Object.entries(record)) {
    byLower.set(key.toLowerCase(), val);
  }
  for (const key of PRIORITY_KEYS) {
    const val = byLower.get(key);
    if (typeof val === "string" && val.trim().length > 0) return val;
  }
  // Last resort: a string-valued id field.
  for (const [key, val] of Object.entries(record)) {
    if (isIdKey(key) && typeof val === "string" && val.trim().length > 0)
      return val;
  }
  return null;
}

/**
 * A short one-line detail for a tool call, or null when nothing salient is
 * present. Never returns raw JSON, object braces, or a multi-line string.
 */
export function toolCallSummary(
  _capability: string,
  inputPreview: unknown,
): string | null {
  const salient = extractSalient(inputPreview);
  return salient === null ? null : tidy(salient);
}
