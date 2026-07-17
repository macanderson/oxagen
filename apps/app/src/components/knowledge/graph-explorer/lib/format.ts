/**
 * format.ts — type-aware formatting for node/edge property values.
 *
 * The graph stores heterogeneous property bags (strings, numbers, booleans,
 * ISO dates, urls, arrays, nested objects). The detail panel and edge popover
 * render them as a key/value list, so each value is formatted by its detected
 * type rather than blindly stringified. Pure + node-testable.
 */

// Re-exported so the module's existing consumers (copyable-id, edge-hover-popover,
// graph-canvas-view) don't need an import-path change — the shared @/lib/utils
// implementation is byte-identical to this module's former local definition.
export { truncate, truncateMiddle } from "@/lib/utils";

export type PropertyKind =
  | "null"
  | "boolean"
  | "number"
  | "date"
  | "url"
  | "string"
  | "array"
  | "object";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Detect the rendering kind for an arbitrary property value. */
export function detectKind(value: unknown): PropertyKind {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    if (URL_RE.test(value)) return "url";
    if (ISO_DATE_RE.test(value)) return "date";
    return "string";
  }
  return "string";
}

/**
 * Format a value to a display string. Dates render in the viewer's locale,
 * numbers get thousands separators, arrays/objects render compactly, and
 * everything else falls back to a trimmed string. `null`/`undefined` render as
 * an em dash so empty cells read as intentional.
 */
export function formatPropertyValue(value: unknown): string {
  const kind = detectKind(value);
  switch (kind) {
    case "null":
      return "—";
    case "boolean":
      return value ? "Yes" : "No";
    case "number":
      return new Intl.NumberFormat().format(value as number);
    case "date": {
      const d = new Date(value as string);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    }
    case "url":
    case "string":
      return String(value);
    case "array": {
      const arr = value as unknown[];
      if (arr.length === 0) return "—";
      return arr.map((v) => formatScalar(v)).join(", ");
    }
    case "object":
      return safeJson(value);
  }
}

/** Compact scalar formatting used inside arrays. */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return safeJson(value);
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Humanize a property key for display: `display_name` / `displayName` /
 * `created-at` → "Display name", "Created at". Acronym-ish all-caps tokens are
 * left intact.
 */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/[_-]+/g, " ") // snake/kebab → spaces
    .trim();
  if (spaced.length === 0) return key;
  // Sentence case, consistently — regardless of whether the source was camel,
  // snake, or kebab. All-caps tokens (acronyms like ID, URL) are preserved.
  return spaced
    .split(/\s+/)
    .map((word, index) => {
      if (word.length > 1 && word === word.toUpperCase()) return word; // acronym
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** Format a 0..1 confidence as a whole-number percentage, e.g. 0.873 → "87%". */
export function formatConfidence(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}
