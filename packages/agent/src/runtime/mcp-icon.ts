// The https URLs an MCP server listing may show, and the icon it shows (#4132).
//
// This file imports nothing, so @oxagen/handlers can pick a catalog entry's
// icon through it without loading the registry client.

/** An https URL a browser may load or link to, or null. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.username === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * The icon to show from a server.json `icons` array. An entry may name a
 * `theme`, the background it was drawn for: `light` or `dark`. The first
 * https icon with no theme or the light theme wins (#4327). A server that
 * offers only dark icons still shows its first https one.
 */
export function iconOf(icons: unknown): string | null {
  if (!Array.isArray(icons)) return null;
  const usable = icons.flatMap((icon: unknown) => {
    if (typeof icon !== "object" || icon === null) return [];
    const src = httpsUrl("src" in icon ? icon.src : undefined);
    if (src === null) return [];
    const theme = "theme" in icon ? icon.theme : undefined;
    return [{ src, theme }];
  });
  const preferred = usable.find(
    (icon) =>
      icon.theme === undefined || icon.theme === null || icon.theme === "light",
  );
  return (preferred ?? usable[0])?.src ?? null;
}
