/**
 * collapseRedundantQuotes — heal doubly-quoted dotenv values.
 *
 * Some Vercel projects store env values with literal surrounding quote
 * characters baked into the value (e.g. the value of NODE_ENV is the 13-byte
 * string `"development"`, quotes included). When `vercel env pull` serialises
 * such a value it wraps it again, producing `NODE_ENV=""development""` on disk.
 * dotenv parsers (Node's `--env-file`, `node:util` parseEnv) read the leading
 * `""` as a complete empty string, so the variable loads as `""` — which breaks
 * any consumer that validates it (e.g. @oxagen/config requireEnv on the api:
 * `NODE_ENV` Invalid enum (received ''), `BETTER_AUTH_URL` Invalid url,
 * `BETTER_AUTH_SECRET` < 32 chars).
 *
 * This collapses exactly one redundant outer quote layer — `""x""` → `"x"` —
 * so the value parses correctly, while leaving correctly single-quoted values
 * (`"x"`) and genuinely empty values (`""`) untouched. It is multi-line aware:
 * a value may span several physical lines (PEM keys, certs), so entries are
 * reconstructed before the value is inspected.
 *
 * KNOWN LIMIT: a value and its trailing blank line or comment cannot be told
 * apart, because any line that is not `KEY=` is treated as a continuation of the
 * value above it. So `FOO=""bar""` followed by a blank line or a `# comment`
 * ends the reconstructed value in `\n`, not `""`, and that entry is left
 * uncollapsed. Rewriting is byte-preserving either way — the entry is simply
 * skipped, never corrupted. `vercel env pull` emits one `KEY=value` per line
 * with no interleaved blanks or comments, which is why this has not bitten.
 */

const KEY_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Entry {
  key: string;
  /** Raw value text, possibly spanning multiple physical lines. */
  value: string;
}

/** A value carrying a redundant outer double-quote layer: `""…""` (len ≥ 4). */
function isDoublyQuoted(value: string): boolean {
  return value.length >= 4 && value.startsWith('""') && value.endsWith('""');
}

/**
 * Collapse one redundant outer double-quote layer on every doubly-quoted value
 * in the dotenv `content`. Returns the rewritten content and how many values
 * were collapsed. A trailing newline in the input is preserved.
 */
export function collapseRedundantQuotes(content: string): {
  content: string;
  collapsed: number;
} {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  // Reconstruct logical entries; continuation lines (no `KEY=`) join the value.
  const entries: Array<Entry | string> = [];
  for (const line of lines) {
    if (KEY_LINE.test(line)) {
      const eq = line.indexOf("=");
      entries.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
    } else if (
      entries.length > 0 &&
      typeof entries[entries.length - 1] === "object"
    ) {
      const prev = entries[entries.length - 1] as Entry;
      prev.value += `\n${line}`;
    } else {
      // Leading blank lines / comments before any key — pass through verbatim.
      entries.push(line);
    }
  }

  let collapsed = 0;
  const out = entries.map((entry) => {
    if (typeof entry === "string") return entry;
    if (isDoublyQuoted(entry.value)) {
      collapsed++;
      return `${entry.key}=${entry.value.slice(1, -1)}`;
    }
    return `${entry.key}=${entry.value}`;
  });

  let result = out.join("\n");
  if (hadTrailingNewline) result += "\n";
  return { content: result, collapsed };
}
