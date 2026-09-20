// In-place edits to an agent definition file (toml-subset.ts). The
// Configuration form patches one key at a time and keeps every other byte
// (comments, order, blank lines), so a form edit diffs like a hand edit and
// the file stays the record (ADR-057 decision 1). Pure and edge-safe.
import { closingFence, type TomlValue } from "./toml-subset";

const HEADER = /^\s*\[\[?([^\]]+)\]\]?/;
/** A key the way the subset parser reads one: a bare dotted key or one quoted key, then `=`. */
const KEY = /^(\s*)([A-Za-z0-9_.-]+|"[^"]*")(\s*=\s*)/;

/** A basic string: escapes for backslash, quote and newline. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** The literal for a value: string, number, boolean, array or inline table. */
export function tomlLiteral(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k} = ${tomlLiteral(v)}`)
      .join(", ")} }`;
  return tomlString(value);
}

/**
 * A multi-line basic string. Escapes are processed inside one, so a
 * backslash is written as two, and the closing fence follows a
 * line-continuation backslash rather than a newline: a newline before the
 * fence is part of the value, and without this every save appended one more
 * blank line to whatever it round-tripped.
 */
export function tomlMultiline(value: string): string {
  return `"""\n${value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"""')}\\\n"""`;
}

/** The path a key spelling names, read as the parser reads it: unquoted, then split on the dots. */
function keyPath(spelling: string): string[] {
  return spelling.replace(/^"|"$/g, "").split(".");
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function startsWithPath(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.length < path.length && prefix.every((p, i) => p === path[i]);
}

/** The index after the basic string that opens at `s[p]`, or the end of `s` when it never closes. */
function basicStringEnd(s: string, p: number): number {
  for (let q = p + 1; q < s.length; q++) {
    const ch = s.charAt(q);
    if (ch === "\\") q++;
    else if (ch === '"') return q + 1;
  }
  return s.length;
}

/**
 * Where the one-line value starting at `s[p]` ends, with the whitespace
 * before a trailing comment left to the tail. Strings are skipped whole, so a
 * `#` inside one is not a comment, and brackets are counted so a comment
 * only starts outside an array or an inline table.
 */
function valueEnd(s: string, p: number): number {
  let depth = 0;
  let q = p;
  while (q < s.length) {
    const ch = s.charAt(q);
    if (ch === '"') {
      q = basicStringEnd(s, q);
      continue;
    }
    if (ch === "'") {
      const close = s.indexOf("'", q + 1);
      q = close < 0 ? s.length : close + 1;
      continue;
    }
    if (ch === "#" && depth === 0) break;
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    q++;
  }
  while (q > p && (s.charAt(q - 1) === " " || s.charAt(q - 1) === "\t")) q--;
  return q;
}

/** One `key = value` line of the file, with the lines a multi-line string takes and the path it writes. */
interface Assignment {
  index: number;
  /** Lines the assignment occupies: 1, or the fence-to-fence count of a multi-line string. */
  span: number;
  /** Indentation, the key as spelled, and the `=` with its spacing. */
  prefix: string;
  /** What follows the value on its last line: whitespace and a comment, or nothing. */
  tail: string;
  /** The full key path, header included. */
  path: string[];
  /** The `[header]` path in force, empty at the root. */
  header: string[];
  /** The key's own parts, as spelled on the line. */
  key: string[];
}

interface Header {
  index: number;
  path: string[];
}

/**
 * Every header and assignment in the file, in order. A multi-line string's
 * body lines are consumed by their assignment, so a line inside one that
 * looks like a key or a header is not read as one. Same fence scan as the
 * parser, so an escaped `"""` inside a body does not end the value here
 * either.
 */
function scan(lines: readonly string[]): {
  headers: Header[];
  assignments: Assignment[];
} {
  const headers: Header[] = [];
  const assignments: Assignment[] = [];
  let header: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const h = HEADER.exec(line);
    if (h !== null) {
      header = (h[1] ?? "").trim().split(".");
      headers.push({ index: i, path: header });
      continue;
    }
    const m = KEY.exec(line);
    if (m === null) continue;
    const prefix = `${m[1] ?? ""}${m[2] ?? ""}${m[3] ?? ""}`;
    const rest = line.slice(prefix.length);
    const key = keyPath(m[2] ?? "");
    let span = 1;
    let tail = "";
    if (rest.startsWith('"""')) {
      const close = closingFence(rest, 3);
      if (close >= 0) tail = rest.slice(close + 3);
      else {
        // The value runs to the line that closes the fence, or to the end of
        // the file when nothing does; the parser refuses that file anyway.
        span = lines.length - i;
        for (let k = i + 1; k < lines.length; k++) {
          const end = closingFence(lines[k] ?? "", 0);
          if (end >= 0) {
            span = k - i + 1;
            tail = (lines[k] ?? "").slice(end + 3);
            break;
          }
        }
      }
    } else {
      tail = rest.slice(valueEnd(rest, 0));
    }
    assignments.push({
      index: i,
      span,
      prefix,
      tail,
      path: [...header, ...key],
      header,
      key,
    });
    i += span - 1;
  }
  return { headers, assignments };
}

/**
 * `text` with `key` in `section` (null for the root table) set to `literal`.
 * `section` is a dotted header path; `key` may be dotted as well, so
 * `(null, "budget.per_run_micros")` and `("budget", "per_run_micros")` name
 * the same value and differ only in where a missing key is written.
 *
 * An existing key is replaced on its own line however it is spelled: bare
 * under its `[section]`, quoted, or as a dotted key higher up
 * (`harness.claude-code.color = …` at the root). Its spelling, its
 * indentation and a trailing comment are kept. When the file names the key
 * more than once the last one is patched, because that is the one the
 * parser's value comes from. A missing key is appended at the end of its
 * `[section]`; when the section exists only as dotted keys, the new key is
 * written the same way after the last of them, since a `[section]` header
 * after dotted keys of the same table is a redefinition; a section the file
 * has in no form is appended at the end.
 */
/**
 * How `table` is spelled in `text`: as a `[table]` header, as dotted keys at
 * the root (`table.key = ...`), or neither (an inline table or no table). Read
 * from the same scan `tomlSet` uses, so a line inside a multi-line body that
 * looks like a header is not one.
 */
export function tomlTableForm(
  text: string,
  table: string,
): "header" | "dotted" | "none" {
  const path = table.split(".");
  const { headers, assignments } = scan(text.split("\n"));
  if (headers.some((h) => samePath(h.path, path))) return "header";
  const dotted = assignments.some(
    (a) =>
      a.header.length === 0 &&
      a.path.length > path.length &&
      samePath(a.path.slice(0, path.length), path),
  );
  return dotted ? "dotted" : "none";
}

export function tomlSet(
  text: string,
  section: string | null,
  key: string,
  literal: string,
): string {
  const lines = text.split("\n");
  const sectionPath = section === null ? [] : section.split(".");
  const target = [...sectionPath, ...keyPath(key)];
  const { headers, assignments } = scan(lines);

  const existing = assignments.findLast((a) => samePath(a.path, target));
  if (existing !== undefined) {
    lines.splice(
      existing.index,
      existing.span,
      ...`${existing.prefix}${literal}${existing.tail}`.split("\n"),
    );
    return lines.join("\n");
  }

  const insertBefore = (at: number, from: number, entry: string): string => {
    let cut = at;
    while (cut > from && lines[cut - 1] === "") cut--;
    lines.splice(cut, 0, entry);
    return lines.join("\n");
  };

  // The section's own `[header]`: append at the end of its block, before
  // the blank lines that separate it from the next header. For the root the
  // block is everything before the first header.
  const own = headers.findLast((h) => samePath(h.path, sectionPath));
  const start = own !== undefined ? own.index + 1 : section === null ? 0 : -1;
  if (start >= 0) {
    const next = headers.find((h) => h.index >= start);
    const end = next !== undefined ? next.index : lines.length;
    return insertBefore(end, start, `${key} = ${literal}`);
  }

  // No header, but dotted keys write into the section from a shallower
  // table: follow the last of them, spelled from the same header.
  const dotted = assignments.findLast(
    (a) => a.key.length > 1 && startsWithPath(a.path, sectionPath),
  );
  if (dotted !== undefined) {
    const relative = sectionPath.slice(dotted.header.length).join(".");
    lines.splice(
      dotted.index + dotted.span,
      0,
      `${relative}.${key} = ${literal}`,
    );
    return lines.join("\n");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push("", `[${sectionPath.join(".")}]`, `${key} = ${literal}`, "");
  return lines.join("\n");
}
