/**
 * resolve-active-tab.ts — pure logic for PageTabs active-state resolution.
 *
 * Extracted to a plain .ts module so it can be imported in node-environment
 * vitest tests without requiring JSX/DOM support.
 *
 * Rule: the active tab is the one whose href is the longest prefix of the
 * current pathname. "Prefix" means exact match OR pathname starts with
 * href + "/" (guards against partial-segment false positives).
 * Falls back to the first tab's href when no prefix matches.
 */

/**
 * Returns the href of the tab whose href is the longest prefix of `pathname`.
 * Falls back to the first tab's href when no match is found.
 */
export function resolveActiveTab(
  tabs: { href: string }[],
  pathname: string,
): string {
  let best: string | null = null;
  let bestLen = -1;

  for (const tab of tabs) {
    const { href } = tab;
    // Exact match OR pathname starts with href + "/" (prevents partial segment hits)
    if (pathname === href || pathname.startsWith(href + "/")) {
      if (href.length > bestLen) {
        best = href;
        bestLen = href.length;
      }
    }
  }

  return best ?? tabs[0]?.href ?? "";
}
