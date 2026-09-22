/**
 * TOML edited as text, for the model base URL contract (`model-base-url.ts`).
 *
 * `@oxagen/tacho` takes no TOML dependency, and people keep comments in
 * `config.toml` and `stella.toml`, so a parse-and-reserialize round trip is
 * out. These helpers find one key by line and change that line only, which
 * keeps every comment, blank line and key order in the file.
 *
 * Two keys are edited this way. Codex's is a top-level `openai_base_url`, and
 * `model-base-url.ts` finds it itself. Stella's is `base_url` inside the
 * `[providers.anthropic]` table, and the table-aware reading lives here.
 */

export interface TomlLine {
  /** The line without its line ending. */
  text: string;
  /** The line ending that followed it; empty on a final unterminated line. */
  eol: string;
}

export function splitLines(text: string): TomlLine[] {
  const lines: TomlLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) break;
    lines.push({ text: match[1] ?? "", eol: match[2] ?? "" });
  }
  return lines;
}

export function joinLines(lines: readonly TomlLine[]): string {
  return lines.map((line) => `${line.text}${line.eol}`).join("");
}

/** The value of a basic or literal TOML string at the start of `rest`. */
export function tomlStringValue(rest: string): string | null {
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
  if (basic !== null) {
    try {
      return JSON.parse(`"${basic[1] ?? ""}"`) as string;
    } catch {
      return basic[1] ?? "";
    }
  }
  const literal = /^'([^']*)'/.exec(rest);
  return literal !== null ? (literal[1] ?? "") : null;
}

/**
 * Each line with the table it sits in, skipping lines inside a multi-line
 * string. `table` is null before the first header, the dotted name with
 * quotes and spaces removed under a `[standard]` header, and undefined under
 * an `[[array]]` header, which no key this contract edits can live in.
 */
function* tomlKeyLines(
  lines: readonly TomlLine[],
): Generator<{
  index: number;
  text: string;
  table: string | null | undefined;
  header: boolean;
}> {
  let fence: string | undefined;
  let table: string | null | undefined = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (fence !== undefined) {
      if (text.includes(fence)) fence = undefined;
      continue;
    }
    if (/^\s*\[\[/.test(text)) {
      table = undefined;
      yield { index, text, table, header: true };
      continue;
    }
    const header = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(text);
    if (header !== null) {
      table = (header[1] ?? "").replace(/["'\s]/g, "");
      yield { index, text, table, header: true };
      continue;
    }
    yield { index, text, table, header: false };
    const opened = /=\s*("""|''')/.exec(text);
    if (opened !== null) {
      const marker = opened[1] as string;
      const after = text.slice(opened.index + opened[0].length);
      if (!after.includes(marker)) fence = marker;
    }
  }
}

const STELLA_TABLE = "providers.anthropic";
const BASE_URL_LINE = /^\s*(?:base_url|"base_url"|'base_url')\s*=\s*(.*)$/;

/**
 * Where Stella's `providers.anthropic.base_url` is in a `stella.toml`.
 *
 * `table` is the one shape this contract edits: a `[providers.anthropic]`
 * header, with `key` the index of its `base_url` line or -1. `conflict` is the
 * table defined some other way (a dotted `providers.anthropic` key, an inline
 * `providers = {…}` or `anthropic = {…}`). A line added beside one of those
 * would make the file one Stella refuses to parse, so the writer leaves it.
 */
export type StellaTomlBaseUrl =
  | { kind: "absent" }
  | { kind: "conflict" }
  | { kind: "table"; header: number; key: number; value: string | null };

export function findStellaBaseUrl(
  lines: readonly TomlLine[],
): StellaTomlBaseUrl {
  let header = -1;
  let key = -1;
  for (const line of tomlKeyLines(lines)) {
    if (line.header) {
      if (line.table === STELLA_TABLE) {
        if (header >= 0) return { kind: "conflict" };
        header = line.index;
      }
      continue;
    }
    const text = line.text;
    if (line.table === null) {
      if (
        /^\s*["']?providers["']?\s*(?:=|\.\s*["']?anthropic["']?\s*[.=])/.test(
          text,
        )
      )
        return { kind: "conflict" };
    } else if (line.table === "providers") {
      if (/^\s*["']?anthropic["']?\s*[.=]/.test(text))
        return { kind: "conflict" };
    } else if (line.table === STELLA_TABLE && key < 0) {
      if (BASE_URL_LINE.test(text)) key = line.index;
    }
  }
  if (header < 0) return { kind: "absent" };
  const rest =
    key >= 0 ? (BASE_URL_LINE.exec(lines[key]?.text ?? "")?.[1] ?? "") : "";
  return {
    kind: "table",
    header,
    key,
    value: key >= 0 ? tomlStringValue(rest) : null,
  };
}

export function stellaBaseUrlLine(url: string): string {
  return `base_url = ${JSON.stringify(url)}`;
}

/**
 * Whether the `[providers.anthropic]` table at `header` holds nothing but
 * blank lines, so a restore that created it can take the header out too. The
 * table ends at the next header or at Tacho's hooks block, which apply puts
 * the table directly before.
 */
export function stellaTableIsEmpty(
  lines: readonly TomlLine[],
  header: number,
): boolean {
  for (let index = header + 1; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (/^\s*\[/.test(text) || /^# >>> tacho enrollment /.test(text))
      return true;
    if (text.trim().length > 0) return false;
  }
  return true;
}
