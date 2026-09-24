// The ⌘K command menu's model (mockup `CMDS` and `cmdMenu()`, audit-prompt
// check 6): every page and action, in the mockup's groups.
//
// - Go: the pages. Fleet, Agents, Tools, Steering and Spend carry ⌘1 to ⌘5.
// - The assistant: open it, or open it with a question drafted, and the model
//   key it answers with.
// - Create: the chooser, then one entry per kind the wizard host carries;
//   every wizard ends on a pull request.
// - Runs, Agents, Approvals and Tools on the belt: what `search_tools` answers
//   for the query, built here from its rows (`fromSearchRows`).
// - Actions: the governed actions, each opening the page that carries its
//   write. One has no write behind it yet (pausing every live run, #3862), so
//   it is listed disabled with the gap it waits on rather than left out.
//
// The static entries filter in the browser; `search_tools` filters the rows it
// returns, so the menu searches both with one query.
import { CREATE_KINDS, type CreateKind } from "@/shared/create";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  type NavKey,
  ORG_NAV,
  WORKSPACE_NAV,
  type WorkspaceNavKey,
  orgHref,
  workspaceHref,
} from "./nav";

/**
 * The groups, in the order the menu draws them.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const COMMAND_GROUPS = [
  "go",
  "assistant",
  "create",
  "runs",
  "agents",
  "approvals",
  "actions",
  "tools",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** The pages ⌘1 to ⌘5 open, in that order (mockup `CMDS` Go). */
const SHORTCUT_PAGES: readonly WorkspaceNavKey[] = [
  "fleet",
  "agents",
  "tools",
  "steering",
  "spend",
];

/** The issue that owns a tool row's missing version, risk, side effect and decision. */
export const TOOL_ROW_GAP = "#3969";

/**
 * The issue that owns the one action with no write, carried as a data attribute only.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const PAUSE_ALL_GAP = "#3862";

type Base = {
  id: string;
  label: string;
  group: CommandGroup;
  /** One line after the label: a run's status, a tool's description, where an action happens. */
  detail?: string;
};

export type Command =
  | (Base & { href: SafePath; shortcut?: number })
  /** Opens the Create chooser (`kind: null`) or one kind's wizard. */
  | (Base & { create: CreateKind | null })
  /** Opens the assistant, with a question drafted when one is given. Never sends it. */
  | (Base & { assistant: string | null })
  /** Opens the approvals drawer. */
  | (Base & { approvals: true })
  /** No write does this yet: listed, disabled, and tied to the issue it waits on. */
  | (Base & { gap: string });

/** The copy the menu's own entries need, beyond the nav labels. */
type CommandTextKey =
  | "assistant.open"
  | "assistant.askTampered"
  | "assistant.askTamperedDraft"
  | "assistant.askCost"
  | "assistant.askCostDraft"
  | "assistant.mintKey"
  | "actions.pauseAll"
  | "actions.pauseAllNotBacked"
  | "actions.steer"
  | "actions.register"
  | "actions.grant"
  | "actions.role"
  | "actions.killSwitch"
  | "actions.export"
  | "actions.exportDetail"
  | "actions.apiKey";

export type CommandLabels = {
  nav: (key: NavKey) => string;
  /** The chooser's label (`null`) or a kind's, e.g. "Add a skill". */
  create: (kind: CreateKind | null) => string;
  text: (key: CommandTextKey) => string;
};

export function buildCommands(
  ctx: { org: string; ws: string | null },
  labels: CommandLabels,
): Command[] {
  const { org, ws } = ctx;
  const out: Command[] = [];
  const go = (key: NavKey, href: SafePath, shortcut?: number) =>
    out.push({
      id: `go:${key}`,
      label: labels.nav(key),
      group: "go",
      href,
      ...(shortcut === undefined ? {} : { shortcut }),
    });

  if (ws !== null) {
    SHORTCUT_PAGES.forEach((key, i) => {
      go(key, workspaceHref(org, ws, key), i + 1);
    });
    for (const key of WORKSPACE_NAV)
      if (!SHORTCUT_PAGES.includes(key)) go(key, workspaceHref(org, ws, key));
  }
  for (const key of ORG_NAV) {
    go(key, orgHref(org, key));
    if (key === "organization") {
      // The organization's other pages, in the tab order.
      go("roles", orgHref(org, "roles"));
      go("apiKeys", orgHref(org, "apiKeys"));
      // Model funding and single sign-on are routes the design does not
      // have (audit-prompt check 1), so the menu does not list them.
    }
  }

  if (ws !== null) {
    out.push(
      {
        id: "assistant:open",
        label: labels.text("assistant.open"),
        group: "assistant",
        assistant: null,
      },
      {
        id: "assistant:tampered",
        label: labels.text("assistant.askTampered"),
        group: "assistant",
        assistant: labels.text("assistant.askTamperedDraft"),
      },
      {
        id: "assistant:cost",
        label: labels.text("assistant.askCost"),
        group: "assistant",
        assistant: labels.text("assistant.askCostDraft"),
      },
    );
  }
  out.push({
    id: "assistant:key",
    label: labels.text("assistant.mintKey"),
    group: "assistant",
    href: routes.modelFunding(org),
  });

  if (ws !== null) {
    out.push({
      id: "create",
      label: labels.create(null),
      group: "create",
      create: null,
    });
    for (const kind of CREATE_KINDS)
      out.push({
        id: `create:${kind}`,
        label: labels.create(kind),
        group: "create",
        create: kind,
      });

    out.push(
      {
        id: "action:pause-all",
        label: labels.text("actions.pauseAll"),
        group: "actions",
        detail: labels.text("actions.pauseAllNotBacked"),
        gap: PAUSE_ALL_GAP,
      },
      {
        id: "action:steer",
        label: labels.text("actions.steer"),
        group: "actions",
        href: routes.fleet(org, ws),
      },
      {
        id: "action:register",
        label: labels.text("actions.register"),
        group: "actions",
        href: routes.register(org, ws, "name"),
      },
      {
        id: "action:grant",
        label: labels.text("actions.grant"),
        group: "actions",
        href: routes.tools(org, ws),
      },
    );
  }
  out.push({
    id: "action:role",
    label: labels.text("actions.role"),
    group: "actions",
    href: routes.roles(org),
  });
  if (ws !== null)
    out.push(
      {
        id: "action:kill-switch",
        label: labels.text("actions.killSwitch"),
        group: "actions",
        href: routes.tools(org, ws, { tab: "switches" }),
      },
      {
        id: "action:export",
        label: labels.text("actions.export"),
        group: "actions",
        detail: labels.text("actions.exportDetail"),
        href: routes.fleet(org, ws),
      },
    );
  out.push({
    id: "action:api-key",
    label: labels.text("actions.apiKey"),
    group: "actions",
    href: routes.apiKeys(org),
  });
  return out;
}

/** One row `search_tools` answered, as the menu reads it. */
export type SearchRowView = {
  kind: "tool" | "run" | "agent" | "approval";
  id: string;
  label: string;
  contextLine: string | null;
};

const GROUP_OF: Record<SearchRowView["kind"], CommandGroup> = {
  run: "runs",
  agent: "agents",
  approval: "approvals",
  tool: "tools",
};

/**
 * `search_tools` rows as menu entries. Rows carry ids, never hrefs, so every
 * target is built here from the typed route builders: a run opens its page,
 * an agent its page, an approval the drawer, a tool the Tools registry.
 */
export function fromSearchRows(
  rows: readonly SearchRowView[],
  ctx: { org: string; ws: string },
): Command[] {
  return rows.map((row): Command => {
    const base = {
      id: `search:${row.kind}:${row.id}`,
      label: row.label,
      group: GROUP_OF[row.kind],
      ...(row.contextLine === null ? {} : { detail: row.contextLine }),
    };
    switch (row.kind) {
      case "run":
        return { ...base, href: routes.run(ctx.org, ctx.ws, row.id) };
      case "agent":
        return { ...base, href: routes.agent(ctx.org, ctx.ws, row.id) };
      case "approval":
        return { ...base, approvals: true };
      case "tool":
        return { ...base, href: routes.tools(ctx.org, ctx.ws) };
    }
  });
}

/** Stable sort into the menu's group order, keeping each group's own order. */
export function orderCommands(commands: readonly Command[]): Command[] {
  const rank = (c: Command) => COMMAND_GROUPS.indexOf(c.group);
  return commands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
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

/** The entry ⌘`digit` opens, when one carries that shortcut. */
export function shortcutCommand(
  commands: readonly Command[],
  digit: number,
): Command | null {
  return commands.find((c) => "shortcut" in c && c.shortcut === digit) ?? null;
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
