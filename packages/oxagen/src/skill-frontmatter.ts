// Imported only by skill consumers. Keep this subpath out of the kernel and contract barrels.
import { isMap, isScalar, parseDocument, Scalar } from "yaml";

export type SkillFrontmatter = {
  /** Every `key: value` line between the fences, in order. */
  fields: Record<string, string>;
  /** The line after the closing fence; the body starts there. */
  bodyStart: number;
};

/** Parse a YAML mapping without aliases or duplicate keys. Invalid YAML fails closed. */
export function readSkillFrontmatter(text: string): SkillFrontmatter | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close < 0) return null;
  try {
    const doc = parseDocument(lines.slice(1, close).join("\n"), {
      uniqueKeys: true,
    });
    if (doc.errors.length > 0) return null;
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [key, item] of Object.entries(value)) {
      if (key === "<<") return null;
      // Retain every key for the grant check, including keys with structured values.
      fields[key] = typeof item === "string" ? item : "";
    }
    return { fields, bodyStart: close + 1 };
  } catch {
    return null;
  }
}

/**
 * Replace the frontmatter `name` value and keep every other byte, including a
 * trailing comment, CRLF line ends, and the body. The YAML parser gives the
 * value's exact source span, so a `#` inside a quoted name and a comment after
 * a plain name are both handled. A missing name is added after the opening
 * fence. Returns null for unreadable frontmatter, a block or structured name,
 * or a result that does not read back as `name`.
 */
export function renameSkillFrontmatterName(
  text: string,
  name: string,
): string | null {
  if (readSkillFrontmatter(text) === null) return null;
  const lines = text.split("\n");
  const close = lines.findIndex(
    (line, index) => index > 0 && line.replace(/\r$/, "") === "---",
  );
  if (close < 0) return null;
  const open = lines[0] ?? "";
  const start = open.length + 1;
  const end = lines.slice(0, close).reduce((n, line) => n + line.length + 1, 0);
  let renamed: string;
  try {
    const doc = parseDocument(text.slice(start, end), { uniqueKeys: true });
    if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
    const value: unknown = doc.contents.get("name", true);
    if (value === undefined) {
      const newline = open.endsWith("\r") ? "\r\n" : "\n";
      renamed = `${text.slice(0, start)}name: ${name}${newline}${text.slice(start)}`;
    } else {
      // Block scalars, sequences, and maps have no single-line value to swap.
      if (!isScalar(value) || value.range == null) return null;
      if (
        value.type !== Scalar.PLAIN &&
        value.type !== Scalar.QUOTE_DOUBLE &&
        value.type !== Scalar.QUOTE_SINGLE
      )
        return null;
      const from = start + value.range[0];
      const to = start + value.range[1];
      // An empty value sits against the colon or a comment, so pad it apart.
      const before =
        from === to && !/[ \t]/.test(text[from - 1] ?? "") ? " " : "";
      const after = from === to && !/[\r\n]/.test(text[to] ?? "\n") ? " " : "";
      renamed = text.slice(0, from) + before + name + after + text.slice(to);
    }
  } catch {
    return null;
  }
  return readSkillFrontmatter(renamed)?.fields.name === name ? renamed : null;
}
