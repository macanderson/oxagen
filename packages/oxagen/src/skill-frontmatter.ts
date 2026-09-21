// Imported only by skill consumers. Keep this subpath out of the kernel and contract barrels.
import { parseDocument } from "yaml";

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
