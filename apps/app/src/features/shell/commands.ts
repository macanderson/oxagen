// The ⌘K command menu's model, per the mockup's CMDS: go to a page, open a
// recent run, start an action, ask the graph. Every entry navigates. An action
// opens the page where it runs as a governed action (the writes land there), so
// the menu never pretends to have done something.
import type { CommandRun } from "./contracts";
import {
  type NavKey,
  ORG_NAV,
  WORKSPACE_NAV,
  orgHref,
  workspaceHref,
} from "./nav";

export type CommandGroup = "go" | "runs" | "actions" | "ask";

export type Command = {
  id: string;
  group: CommandGroup;
  label: string;
  /** Secondary text, e.g. the agent a run belongs to. */
  detail: string | null;
  href: string;
};

/** Action ids, each with the page it opens. Labels live in messages/shell.json (`shell.commands.actions`). */
export const ACTIONS = [
  "steerFleet",
  "registerAgent",
  "openContextPr",
  "grantMandate",
  "createRole",
  "createAutoRule",
  "flipKillSwitch",
  "simulatePolicy",
  "exportBundle",
  "createApiKey",
] as const;
export type ActionId = (typeof ACTIONS)[number];

/** Graph questions from the mockup; each opens Ontology's graph tab with the question. */
export const ASK_QUESTIONS = [
  "enterpriseTickets",
  "releaseNotesCalls",
  "triageWrites",
] as const;
export type AskQuestionId = (typeof ASK_QUESTIONS)[number];

export type CommandLabels = {
  nav: (key: NavKey) => string;
  action: (id: ActionId) => string;
  question: (id: AskQuestionId) => string;
};

function actionHref(
  org: string,
  ws: string | null,
  id: ActionId,
): string | null {
  const inWs = (path: string) =>
    ws === null ? null : `${workspaceHref(org, ws, "fleet")}${path}`;
  switch (id) {
    case "steerFleet":
      return inWs("");
    case "registerAgent":
      return ws === null ? null : workspaceHref(org, ws, "register");
    case "openContextPr":
      return inWs("/steering");
    case "grantMandate":
      return inWs("/tools/mandates");
    case "createAutoRule":
      return inWs("/tools/auto");
    case "flipKillSwitch":
      return inWs("/tools/switches");
    case "simulatePolicy":
      return inWs("/tools/policy");
    case "createRole":
      return orgHref(org, "roles");
    case "exportBundle":
      return `${orgHref(org, "audit")}/exports`;
    case "createApiKey":
      return orgHref(org, "apiKeys");
  }
}

export function buildCommands(
  ctx: { org: string; ws: string | null; runs: readonly CommandRun[] },
  labels: CommandLabels,
): Command[] {
  const { org, ws } = ctx;
  const out: Command[] = [];
  const go = (key: NavKey, href: string) =>
    out.push({
      id: `go:${key}`,
      group: "go",
      label: labels.nav(key),
      detail: null,
      href,
    });

  if (ws !== null)
    for (const key of WORKSPACE_NAV) go(key, workspaceHref(org, ws, key));
  for (const key of ORG_NAV) {
    go(key, orgHref(org, key));
    if (key === "organization") {
      go("apiKeys", orgHref(org, "apiKeys"));
      go("roles", orgHref(org, "roles"));
    }
  }

  for (const run of ctx.runs)
    out.push({
      id: `run:${run.id}`,
      group: "runs",
      label: run.id,
      detail: run.agentKey,
      href: `${workspaceHref(org, run.workspace, "fleet")}/runs/${encodeURIComponent(run.id)}`,
    });

  for (const id of ACTIONS) {
    const href = actionHref(org, ws, id);
    if (href !== null)
      out.push({
        id: `action:${id}`,
        group: "actions",
        label: labels.action(id),
        detail: null,
        href,
      });
  }

  if (ws !== null)
    for (const id of ASK_QUESTIONS) {
      const question = labels.question(id);
      out.push({
        id: `ask:${id}`,
        group: "ask",
        label: question,
        detail: null,
        href: `${workspaceHref(org, ws, "ontology")}/graph?q=${encodeURIComponent(question)}`,
      });
    }
  return out;
}

/** Case- and accent-insensitive match of every whitespace-separated term against label and detail. */
export function filterCommands(
  commands: readonly Command[],
  query: string,
): Command[] {
  const fold = (s: string) =>
    s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];
  return commands.filter((c) => {
    const haystack = fold(`${c.label} ${c.detail ?? ""}`);
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

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  "go",
  "runs",
  "actions",
  "ask",
];

/** Group filtered commands in display order, dropping empty groups. */
export function groupCommands(
  commands: readonly Command[],
): { group: CommandGroup; items: Command[] }[] {
  return COMMAND_GROUPS.map((group) => ({
    group,
    items: commands.filter((c) => c.group === group),
  })).filter((g) => g.items.length > 0);
}
