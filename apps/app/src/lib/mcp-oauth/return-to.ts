/**
 * return-to.ts — validates the post-OAuth redirect target for the MCP
 * authorize flow.
 *
 * The authorize route accepts a caller-supplied `returnTo` so the user lands
 * back on whichever surface launched the flow (Agent Tools → MCP Servers,
 * a marketplace card, …). Because the value round-trips through the OAuth
 * state store and ends up in a NextResponse.redirect, it must never become an
 * open-redirect: only same-origin paths inside the caller's own org are
 * accepted; anything else falls back to the MCP Servers page.
 */

/** Default landing page for the flow: Studio → Agent Tools → MCP Servers. */
export function defaultMcpReturnTo(orgSlug: string, workspaceSlug: string): string {
  return `/${orgSlug}/${workspaceSlug}/studio/tools/mcp`;
}

/**
 * Returns `raw` when it is a safe same-origin path inside this org, else the
 * MCP Servers page for the given scope.
 */
export function resolveReturnTo(
  raw: string | null | undefined,
  orgSlug: string,
  workspaceSlug: string,
): string {
  const fallback = defaultMcpReturnTo(orgSlug, workspaceSlug);
  if (!raw) return fallback;
  // Path-only: no scheme-relative ("//evil.com"), no backslash tricks
  // (browsers normalise "\" to "/"), no absolute URLs, no embedded CR/LF.
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\") || raw.includes("://")) return fallback;
  if (/[\r\n]/.test(raw)) return fallback;
  // Stay inside the requesting org's URL space.
  if (raw !== `/${orgSlug}` && !raw.startsWith(`/${orgSlug}/`)) return fallback;
  return raw;
}
