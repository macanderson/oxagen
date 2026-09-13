/**
 * Plugin listing icon helpers.
 *
 * `plugin.org_listings.iconUrl` is a free-form column with two distinct
 * producers:
 *   - MCP server / integration / content-tool catalog rows store a real, often
 *     remote, image URL.
 *   - Capability-pack installs historically stored the manifest's Lucide icon
 *     *name* (e.g. "image") — which is NOT a URL. Feeding that to next/image
 *     throws "Failed to construct 'URL': Invalid URL".
 *
 * Every surface that renders a listing icon must therefore gate next/image on
 * a real URL and fall back to a glyph otherwise.
 */
export function isRenderableImageUrl(
  value: string | null | undefined,
): value is string {
  if (!value) return false;
  return /^https?:\/\//.test(value) || value.startsWith("/");
}
