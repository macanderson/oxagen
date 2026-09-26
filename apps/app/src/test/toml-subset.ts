// A TOML subset parser for tests: basic and literal strings, multi-line basic
// strings, integers and floats, booleans, arrays, inline tables, dotted and
// quoted keys, and `[table]` headers. It was the agent definition editor's
// parser; the definition file went with ADR-192, and the one reader left is
// the Repositories test that parses the `.oxagen/` files the init pull
// request drafts. Pure and edge-safe.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

/**
 * Why a line does not parse; the editor prints the catalog sentence for the
 * code at its line. `unreadable_value` also covers an escape TOML does not
 * define, such as `\q` or a `\u` with the wrong digit count, because a
 * value that cannot be decoded is a value that cannot be read.
 */
type TomlErrorCode =
  | "unterminated_string"
  | "unterminated_array"
  | "array_separator"
  | "inline_table_key"
  | "inline_table_separator"
  | "missing_value"
  | "unreadable_value"
  | "expected_key_value"
  | "text_after_value";

export type TomlParse =
  | { ok: true; doc: TomlTable }
  | { ok: false; code: TomlErrorCode; line: number };

class TomlSyntaxError extends Error {
  constructor(
    readonly code: TomlErrorCode,
    /** Zero-based. */
    readonly line: number,
  ) {
    super(code);
  }
}

/**
 * TOML's basic-string escapes, the set `tomlBasicString` in
 * `packages/tacho/src/host/stella-writer.ts` emits. `\u` and `\U` take a
 * hex code and are handled in `unescape`; anything else after a backslash
 * is a refusal, since dropping the backslash would silently change the value.
 */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["b", "\b"],
  ["t", "\t"],
  ["n", "\n"],
  ["f", "\f"],
  ["r", "\r"],
  ['"', '"'],
  ["\\", "\\"],
]);
const UNICODE_ESCAPE_DIGITS: ReadonlyMap<string, number> = new Map([
  ["u", 4],
  ["U", 8],
]);
const KEY = /^([A-Za-z0-9_.-]+|"[^"]*")\s*=/;
const TABLE_HEADER = /^\[\[?([^\]]+)\]\]?\s*(#.*)?$/;
const BOOLEAN = /^(true|false)\b/;
const NUMBER = /^[-+]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?\b/;

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value);
}

/** A key the file names, read as an own property only, so `__proto__` or `constructor` is just a key. */
export function tomlGet(table: TomlTable, key: string): TomlValue | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function setOwn(table: TomlTable, key: string, value: TomlValue): void {
  Object.defineProperty(table, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function childTable(parent: TomlTable, key: string): TomlTable {
  const existing = tomlGet(parent, key);
  if (isTable(existing)) return existing;
  const child: TomlTable = {};
  setOwn(parent, key, child);
  return child;
}

/** `a.b.c = v` writes `v` at `c` inside the tables `a` and `b`, creating them. */
function setPath(table: TomlTable, path: string, value: TomlValue): void {
  const parts = path.split(".");
  const last = parts.pop() ?? path;
  let target = table;
  for (const part of parts) target = childTable(target, part);
  setOwn(target, last, value);
}

const unquote = (key: string): string => key.replace(/^"|"$/g, "");

/**
 * The index of the first `"""` at or after `from` that is not escaped, or
 * -1. A fence is escaped when an odd number of backslashes precedes it: in
 * `\\"""` the pair is one escaped backslash and the fence closes the string,
 * while in `\"""` the backslash escapes the first quote. The patcher uses the
 * same scan to find where a multi-line value ends, so writer and reader agree.
 */
export function closingFence(s: string, from: number): number {
  let at = s.indexOf('"""', from);
  while (at >= 0) {
    let backslashes = 0;
    while (at - backslashes > 0 && s.charAt(at - backslashes - 1) === "\\")
      backslashes++;
    if (backslashes % 2 === 0) return at;
    at = s.indexOf('"""', at + 1);
  }
  return at;
}

/**
 * The character an escape at `raw[i]` (the backslash) stands for, and the
 * index of the last character it consumed; `null` when the escape is not one
 * TOML defines. `\u` and `\U` need exactly 4 or 8 hex digits and must name a
 * scalar value: a lone surrogate is not a character a string can carry.
 */
function unescape(raw: string, i: number): [string, number] | null {
  const next = raw.charAt(i + 1);
  const known = ESCAPES.get(next);
  if (known !== undefined) return [known, i + 1];
  const digits = UNICODE_ESCAPE_DIGITS.get(next);
  if (digits === undefined) return null;
  const hex = raw.slice(i + 2, i + 2 + digits);
  if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  const code = Number.parseInt(hex, 16);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return [String.fromCodePoint(code), i + 1 + digits];
}

/** The escapes of a basic string, plus the line-ending backslash, applied to a multi-line body. */
function unescapeMultiline(raw: string, line: number): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw.charAt(i + 1);
    if (next === "\n" || next === "\r") {
      i++;
      while (i + 1 < raw.length && /[ \t\r\n]/.test(raw.charAt(i + 1))) i++;
      continue;
    }
    const decoded = unescape(raw, i);
    if (decoded === null) throw new TomlSyntaxError("unreadable_value", line);
    out += decoded[0];
    i = decoded[1];
  }
  return out;
}

function skipBlanks(s: string, p: number): number {
  let q = p;
  while (s.charAt(q) === " " || s.charAt(q) === "\t") q++;
  return q;
}

export function parseTomlSubset(text: string): TomlParse {
  const lines = text.split("\n");
  const doc: TomlTable = {};
  let current = doc;
  let index = 0;

  /**
   * A `"""` string: closed on its own line, or read on until the line that
   * closes it (end -1). Escapes are processed as in a basic string, and a
   * backslash before a line end swallows the newline and the whitespace
   * after it (TOML's line-ending backslash), so a writer can close the fence
   * without adding a newline to the value.
   */
  function multiline(s: string, p: number, line: number): [string, number] {
    const rest = s.slice(p + 3);
    const close = closingFence(rest, 0);
    if (close >= 0)
      return [
        unescapeMultiline(rest.slice(0, close).replace(/^\r?\n/, ""), line),
        p + 3 + close + 3,
      ];
    // A CRLF file leaves "\r" on the fence line; TOML trims the newline that
    // follows an opening fence, so that carriage return is not body text.
    const first = rest.replace(/^\r$/, "");
    const parts = first.length > 0 ? [first] : [];
    for (index++; index < lines.length; index++) {
      const next = lines[index] ?? "";
      const end = closingFence(next, 0);
      if (end >= 0) {
        parts.push(next.slice(0, end));
        return [unescapeMultiline(parts.join("\n"), line), -1];
      }
      parts.push(next);
    }
    throw new TomlSyntaxError("unterminated_string", line);
  }

  function basic(s: string, p: number, line: number): [string, number] {
    let out = "";
    for (let q = p + 1; q < s.length; q++) {
      const ch = s.charAt(q);
      if (ch === "\\") {
        const decoded = unescape(s, q);
        if (decoded === null)
          throw new TomlSyntaxError("unreadable_value", line);
        out += decoded[0];
        q = decoded[1];
      } else if (ch === '"') {
        return [out, q + 1];
      } else {
        out += ch;
      }
    }
    throw new TomlSyntaxError("unterminated_string", line);
  }

  function array(s: string, p: number, line: number): [TomlValue[], number] {
    const items: TomlValue[] = [];
    let q = p + 1;
    for (;;) {
      q = skipBlanks(s, q);
      if (s.charAt(q) === "]") return [items, q + 1];
      if (q >= s.length) throw new TomlSyntaxError("unterminated_array", line);
      const [item, end] = value(s, q, line, false);
      items.push(item);
      q = skipBlanks(s, end);
      if (q >= s.length) throw new TomlSyntaxError("unterminated_array", line);
      if (s.charAt(q) === ",") q++;
      else if (s.charAt(q) !== "]")
        throw new TomlSyntaxError("array_separator", line);
    }
  }

  function inlineTable(
    s: string,
    p: number,
    line: number,
  ): [TomlTable, number] {
    const table: TomlTable = {};
    let q = p + 1;
    for (;;) {
      q = skipBlanks(s, q);
      if (s.charAt(q) === "}") return [table, q + 1];
      const key = KEY.exec(s.slice(q));
      if (key === null) throw new TomlSyntaxError("inline_table_key", line);
      q += key[0].length;
      const [item, end] = value(s, q, line, false);
      setPath(table, unquote(key[1] ?? ""), item);
      q = skipBlanks(s, end);
      if (s.charAt(q) === ",") q++;
      else if (s.charAt(q) !== "}")
        throw new TomlSyntaxError("inline_table_separator", line);
    }
  }

  /** The value starting at `p`, and where it ends: -1 when a multi-line string consumed further lines. */
  function value(
    s: string,
    p: number,
    line: number,
    topLevel: boolean,
  ): [TomlValue, number] {
    const q = skipBlanks(s, p);
    const head = s.charAt(q);
    const rest = s.slice(q);
    if (rest.startsWith('"""')) {
      if (topLevel) return multiline(s, q, line);
      // A multi-line string inside an array or an inline table is outside the subset.
      throw new TomlSyntaxError("unreadable_value", line);
    }
    if (head === '"') return basic(s, q, line);
    if (head === "'") {
      const close = s.indexOf("'", q + 1);
      if (close < 0) throw new TomlSyntaxError("unterminated_string", line);
      return [s.slice(q + 1, close), close + 1];
    }
    if (head === "[") return array(s, q, line);
    if (head === "{") return inlineTable(s, q, line);
    const bool = BOOLEAN.exec(rest);
    if (bool !== null) return [bool[0] === "true", q + bool[0].length];
    const number = NUMBER.exec(rest);
    if (number !== null)
      return [Number(number[0].replace(/_/g, "")), q + number[0].length];
    throw new TomlSyntaxError(
      head === "" ? "missing_value" : "unreadable_value",
      line,
    );
  }

  try {
    for (index = 0; index < lines.length; index++) {
      const line = index;
      const s = (lines[line] ?? "").replace(/^\s+/, "");
      if (s === "" || s.startsWith("#")) continue;
      const header = TABLE_HEADER.exec(s);
      if (header !== null) {
        current = doc;
        for (const part of (header[1] ?? "").trim().split("."))
          current = childTable(current, part);
        continue;
      }
      const key = KEY.exec(s);
      if (key === null) throw new TomlSyntaxError("expected_key_value", line);
      const [parsed, end] = value(s, key[0].length, line, true);
      if (end >= 0) {
        const after = s.slice(end).trim();
        if (after !== "" && !after.startsWith("#"))
          throw new TomlSyntaxError("text_after_value", line);
      }
      setPath(current, unquote(key[1] ?? ""), parsed);
    }
  } catch (error) {
    if (error instanceof TomlSyntaxError)
      return { ok: false, code: error.code, line: error.line + 1 };
    throw error;
  }
  return { ok: true, doc };
}
