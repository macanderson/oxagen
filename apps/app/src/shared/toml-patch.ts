// In-place edits to an agent definition file (toml-subset.ts). The
// Configuration form patches one key at a time and keeps every other byte —
// comments, order, blank lines — so a form edit diffs like a hand edit and the
// file stays the record (ADR-057 decision 1). Pure and edge-safe.
import type { TomlValue } from "./toml-subset";

const HEADER = /^\s*\[\[?([^\]]+)\]\]?/;
const ANY_HEADER = /^\s*\[/;

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

/**
 * `text` with `key` in `section` (null for the root table) set to `literal`.
 * An existing key is replaced on its line, keeping a trailing comment; a
 * missing key is appended at the end of its section; a missing section is
 * appended at the end of the file.
 */
export function tomlSet(
  text: string,
  section: string | null,
  key: string,
  literal: string,
): string {
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  if (section === null) {
    start = 0;
    const first = lines.findIndex((line) => ANY_HEADER.test(line));
    if (first >= 0) end = first;
  } else {
    for (let i = 0; i < lines.length; i++) {
      const m = HEADER.exec(lines[i] ?? "");
      if (m !== null && m[1]?.trim() === section) {
        start = i + 1;
        const next = lines.findIndex(
          (line, j) => j >= start && ANY_HEADER.test(line),
        );
        if (next >= 0) end = next;
        break;
      }
    }
    if (start < 0) {
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push("", `[${section}]`, `${key} = ${literal}`, "");
      return lines.join("\n");
    }
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyed = new RegExp(`^(\\s*${escaped}\\s*=\\s*)`);
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? "";
    const m = keyed.exec(line);
    if (m === null) continue;
    const prefix = m[1] ?? "";
    const rest = line.slice(prefix.length);
    let tail = "";
    let span = 1;
    if (rest.startsWith('"""') && !rest.includes('"""', 3)) {
      // The value runs to the line that closes the fence.
      for (let k = i + 1; k < end; k++) {
        span++;
        if ((lines[k] ?? "").includes('"""')) break;
      }
    } else {
      const comment = /\s+#.*$/.exec(rest);
      if (comment !== null) tail = comment[0];
    }
    lines.splice(i, span, ...`${prefix}${literal}${tail}`.split("\n"));
    return lines.join("\n");
  }
  let at = end;
  while (at > start && lines[at - 1] === "") at--;
  lines.splice(at, 0, `${key} = ${literal}`);
  return lines.join("\n");
}
