/**
 * csv.ts — client-side CSV serialization + download for list/table exports.
 *
 * Shared by every list page's "Export" button (see `list-toolbar.tsx` and
 * `useListControls`) so exports are byte-for-byte consistent: RFC-4180
 * quoting/escaping plus a formula-injection guard. This is deliberately a
 * separate, generic implementation from `@/lib/audit-export.ts` (which
 * serializes a fixed audit-log column set server-side and HMAC-signs the
 * result for tamper-evidence) — this module is for ad-hoc, purely
 * client-side exports of whatever rows a list toolbar currently has on
 * screen.
 */

/** One export column: `key` looks up the row value, `header` is the CSV title. */
export interface CsvColumn {
  key: string;
  header: string;
}

/**
 * Leading characters (`=`, `+`, `-`, `@`) that Excel/Sheets/Numbers evaluate
 * as a formula when a CSV cell opens with them — the classic "CSV injection"
 * vector. Also treats a leading tab or carriage return as dangerous, since
 * some spreadsheet parsers skip leading whitespace before checking for a
 * formula prefix.
 */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

/** RFC-4180: a field needs quoting if it contains a comma, quote, or line break. */
const NEEDS_QUOTING_RE = /["\r\n,]/;

function csvField(raw: unknown): string {
  let value = raw === null || raw === undefined ? "" : String(raw);

  // Formula-injection guard: prefix a single quote so spreadsheet apps render
  // the cell as literal text instead of evaluating it as a formula. This
  // intentionally also neutralizes legitimate leading `-` (negative numbers)
  // and `+` — the standard, conservative mitigation for untrusted CSV output.
  if (FORMULA_PREFIX_RE.test(value)) {
    value = `'${value}`;
  }

  if (NEEDS_QUOTING_RE.test(value)) {
    value = `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

/**
 * Serializes `rows` into an RFC-4180 CSV string (CRLF line endings, trailing
 * CRLF) using `columns` for both the header row and per-row cell order.
 * Values are read via `row[column.key]` and stringified with `String()`
 * (`null`/`undefined` become an empty field) — format numbers/dates on the
 * row objects beforehand if a different textual representation is needed.
 *
 *   toCsv(
 *     [{ key: "name", header: "Name" }, { key: "email", header: "Email" }],
 *     [{ name: "Ada Lovelace", email: "ada@example.com" }],
 *   );
 *   // 'Name,Email\r\n"Ada Lovelace",ada@example.com\r\n'
 */
export function toCsv(
  columns: CsvColumn[],
  rows: Record<string, unknown>[],
): string {
  const header = columns.map((c) => csvField(c.header)).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => csvField(row[c.key])).join(","),
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

/**
 * Triggers a client-side download of `csvString` as `filename` via a
 * throwaway `Blob` + anchor click (no server round-trip). Prepends a UTF-8
 * BOM so Excel auto-detects the encoding instead of mis-reading accented
 * characters. No-ops when `document` is unavailable (SSR / non-browser test
 * environments) rather than throwing.
 */
export function downloadCsv(filename: string, csvString: string): void {
  if (typeof document === "undefined") return;

  const BOM = "\uFEFF";
  const blob = new Blob([BOM, csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
