// The ⌘K command menu's model: go to a page. Rev1 lists the static routes and
// nothing else (ARCHITECTURE.md §1.2); every entry navigates.
import {
  type NavKey,
  ORG_NAV,
  WORKSPACE_NAV,
  orgHref,
  workspaceHref,
} from "./nav";
import type { SafePath } from "@/shared/safe-path";

export type Command = {
  id: string;
  label: string;
  href: SafePath;
};

export type CommandLabels = {
  nav: (key: NavKey) => string;
};

export function buildCommands(
  ctx: { org: string; ws: string | null },
  labels: CommandLabels,
): Command[] {
  const { org, ws } = ctx;
  const out: Command[] = [];
  const go = (key: NavKey, href: SafePath) =>
    out.push({ id: `go:${key}`, label: labels.nav(key), href });

  if (ws !== null)
    for (const key of WORKSPACE_NAV) go(key, workspaceHref(org, ws, key));
  for (const key of ORG_NAV) {
    go(key, orgHref(org, key));
    if (key === "organization") {
      go("apiKeys", orgHref(org, "apiKeys"));
    }
  }
  return out;
}

/** Case- and accent-insensitive match of every whitespace-separated term against the label. */
export function filterCommands(
  commands: readonly Command[],
  query: string,
): Command[] {
  const fold = (s: string) =>
    s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];
  return commands.filter((c) => {
    const haystack = fold(c.label);
    return terms.every((term) => haystack.includes(term));
  });
}

/** Move the highlighted option by `delta`, wrapping at both ends. -1 means nothing highlighted. */
export function moveHighlight(
  index: number,
  delta: number,
  length: number,
): number {
  if (length === 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  return (((index + delta) % length) + length) % length;
}
