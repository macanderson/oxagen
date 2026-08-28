/**
 * Pure `.env` parsing + key-name validation for the credential vault.
 * No I/O, no secrets logging — kept separate so it is exhaustively unit-tested.
 */

/** Env-var name rule shared by the vault: POSIX-ish identifier. */
export const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidSecretKeyName(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export interface ParsedEnvEntry {
  key: string;
  value: string;
}

/**
 * Parse pasted `.env` text into entries:
 *   - accepts `KEY=VALUE`, `export KEY=VALUE`, `KEY="value"`, `KEY='value'`, `KEY=`
 *   - strips surrounding quotes, preserving inner content (including `=` and `#`)
 *   - ignores blank lines and `#` comment lines
 *   - strips trailing inline comments only when the value is unquoted
 *   - skips lines whose key is not a valid env-var name
 */
export function parseEnvText(text: string): ParsedEnvEntry[] {
  const out: ParsedEnvEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (line === "" || line.startsWith("#")) continue;

    // Optional `export ` prefix.
    const body = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;

    const eq = body.indexOf("=");
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    if (!isValidSecretKeyName(key)) continue;

    out.push({ key, value: parseValue(body.slice(eq + 1)) });
  }
  return out;
}

function parseValue(raw: string): string {
  const rest = raw.trimStart();
  if (rest === "") return "";

  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    // Unterminated quote: take everything after the opening quote (lenient).
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }

  // Unquoted: a `#` preceded by whitespace begins an inline comment.
  const comment = rest.search(/\s#/);
  const value = comment === -1 ? rest : rest.slice(0, comment);
  return value.trim();
}
