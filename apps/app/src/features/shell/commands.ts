// The ⌘K command menu's model: go to a page, or create something. The pages
// are the static routes (ARCHITECTURE.md §1.2). Inside a workspace the menu
// also offers Create (roadmap creation-spec §1, the mockup's "Create" group):
// the chooser, then one entry per kind the wizard shell hosts. Each create
// entry opens a wizard over the current page, and every wizard ends on a pull
// request.
import { CREATE_KINDS, type CreateKind } from "@/shared/create";
import {
  type NavKey,
  ORG_NAV,
  WORKSPACE_NAV,
  orgHref,
  workspaceHref,
} from "./nav";
import type { SafePath } from "@/shared/safe-path";

export type Command =
  | { id: string; label: string; href: SafePath }
  /** Opens the Create chooser (`kind: null`) or one kind's wizard. */
  | { id: string; label: string; create: CreateKind | null };

export type CommandLabels = {
  nav: (key: NavKey) => string;
  /** The chooser's label (`null`) or a kind's, e.g. "Add a skill". */
  create: (kind: CreateKind | null) => string;
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
      // The organization's other pages, in the tab order.
      go("roles", orgHref(org, "roles"));
      go("apiKeys", orgHref(org, "apiKeys"));
      go("modelFunding", orgHref(org, "modelFunding"));
    }
  }
  if (ws !== null) {
    out.push({ id: "create", label: labels.create(null), create: null });
    for (const kind of CREATE_KINDS)
      out.push({
        id: `create:${kind}`,
        label: labels.create(kind),
        create: kind,
      });
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
