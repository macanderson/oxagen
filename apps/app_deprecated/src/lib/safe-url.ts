/**
 * URL-scheme allow-listing for any model- or server-supplied value that ends up
 * in an `<a href>` or assigned to `window.location`. Without this guard a
 * `javascript:` / `data:` URL coming from agent output, a web-search result, or
 * a stored notification becomes XSS-via-navigation.
 *
 * Safe = an http(s) absolute URL, or a same-document relative reference
 * (path-absolute `/…`, fragment `#…`, or query `?…`). Everything else —
 * `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, every scheme-relative
 * spelling (`//host`, `/\host`, `\\host`, `\/host`), and anything unparseable
 * — is rejected.
 */

/**
 * Remove C0 (0x00–0x1F) and DEL (0x7F) control characters. Browsers strip these
 * while resolving a scheme, so `java\tscript:alert(1)` would navigate as
 * `javascript:`. Stripping them BEFORE the protocol check defeats that
 * obfuscation. Implemented by char code to avoid a control-character regex
 * literal.
 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) out += ch;
  }
  return out;
}

export function safeHref(url: string | null | undefined): string | undefined {
  if (typeof url !== "string") return undefined;

  const normalized = stripControlChars(url.trim());
  if (normalized.length === 0) return undefined;

  // Same-document relative references stay on the current origin.
  //
  // A leading `/` is only same-origin when the NEXT character is not another
  // slash. WHATWG URL parsing treats a backslash exactly like a forward slash
  // when deciding whether a reference is scheme-relative, so `//evil.com`,
  // `/\evil.com`, `\\evil.com` and `\/evil.com` all resolve to the authority
  // `evil.com`. Checking only for the literal `//` would let the backslash
  // spellings through as "relative" and turn agent-supplied output into an
  // off-origin navigation.
  if (normalized.startsWith("\\")) return undefined;
  const second = normalized.charAt(1);
  if (normalized.startsWith("/") && (second === "/" || second === "\\")) {
    return undefined; // scheme-relative → external origin
  }
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("#") ||
    normalized.startsWith("?")
  ) {
    return normalized;
  }

  // Absolute reference: permit only http/https.
  try {
    const { protocol } = new URL(normalized);
    return protocol === "http:" || protocol === "https:"
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

/** Boolean form of {@link safeHref}. */
export function isSafeHref(url: string | null | undefined): boolean {
  return safeHref(url) !== undefined;
}
