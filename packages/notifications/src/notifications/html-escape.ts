/**
 * The two escaping primitives every notification email template uses.
 *
 * There is no template engine here on purpose — the templates are plain tagged
 * strings — so escaping is the caller's job and must be done at every single
 * interpolation point. Keeping both helpers in one module means a hardening fix
 * lands once instead of being copy-pasted into each template (and forgotten in
 * some of them).
 */

/**
 * Escape a value for interpolation into HTML text or a double-quoted attribute.
 *
 * Single quotes are deliberately not escaped: every attribute in these
 * templates is double-quoted, so `"` is the only quote that can break out.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape a URL for use inside an `href="..."` attribute, additionally
 * rejecting any non-http(s) scheme. HTML escaping alone does not neutralize
 * dangerous URI schemes (e.g. `javascript:alert(1)` contains no HTML-special
 * characters), so a plain {@link esc} on an href is an XSS vector in email
 * clients that execute JavaScript in anchor hrefs. This guard fails closed.
 */
export function safeHref(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Unsafe URL scheme in email template: ${url}`);
  }
  return esc(url);
}
