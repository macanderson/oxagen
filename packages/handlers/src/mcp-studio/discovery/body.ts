// body.ts: the title, body, and commit message of a sync steering PR
// (lane M10, #4682; mcp-studio-spec, Sync).
//
// The body carries the tool surface diff in the spec's format:
//
//   tools/servers/billing  openapi.yaml changed at aintel/billing-service@4be91d2
//
//     + list_disputes            new operation, not imported
//     ~ billing__create_refund   3 → 4   breaking, withheld until merge
//         new required input: currency (string, ISO 4217)
//
//   Definitions: 6,120 → 6,410 tokens per request (budget 8,000)
//
// Every text here comes from the source or the steering repo, never from a
// credential, and sync.ts scrubs the result before it leaves the run.
import type {
  ServerSource,
  ToolSurfaceDiff,
  ToolSurfaceDiffEntry,
} from "@oxagen/mcp-studio";
import { TOOL_SERVERS_DIR } from "@oxagen/oxagen/steering-repo";
import type { DiscoveryTrigger } from "./types";

/** An upstream description in the diff is cut to this many characters. */
const DESCRIPTION_MAX = 240;

/** The gap between the name column and the text after it. */
const COLUMN_GAP = 3;

/** What one sync steering PR says. */
export interface SyncPullRequestText {
  /** The folder name under tools/servers/. */
  server: string;
  /** server.toml's label. */
  label: string;
  sourceType: ServerSource["type"];
  /** The diff header's text after the folder path. */
  origin: string;
  diff: ToolSurfaceDiff;
  /** Full tool names the gateway withholds until the PR merges. */
  withheld: readonly string[];
  /** tools.toml keys the proposed lock leaves out, because they no longer compile. */
  dropped: readonly string[];
  /** A registry server's source.version move, when the catalog moved on. */
  version: { from: string; to: string } | undefined;
  trigger: DiscoveryTrigger;
  at: Date;
  /** The machine that reported a local server's tools. */
  machine: string | null;
}

type Entry = ToolSurfaceDiffEntry;
type ChangedEntry = Extract<Entry, { change: "changed" }>;

/** What a tool the source offers is called, by kind of source. */
function offeredNoun(type: ServerSource["type"]): string {
  switch (type) {
    case "openapi":
      return "operation";
    case "graphql":
      return "field";
    case "grpc":
      return "method";
    default:
      return "tool";
  }
}

const TRIGGER_TEXT: Record<DiscoveryTrigger, string> = {
  schedule: "the server's schedule",
  list_changed: "the server's tools/list_changed notification",
  push: "a push that changed the definition",
  registry_version: "a new version in the registry catalog",
  manual: "a request from Studio",
  lock_merged: "a merged steering PR for this server",
};

/** "2026-09-26 03:00 UTC". */
function utcText(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** One line of upstream text: whitespace folded, and cut to fit. */
function oneLine(text: string | undefined): string {
  const folded = (text ?? "").replace(/\s+/g, " ").trim();
  if (folded.length === 0) return "(none)";
  return folded.length > DESCRIPTION_MAX
    ? `${folded.slice(0, DESCRIPTION_MAX - 1)}…`
    : folded;
}

function nameOf(entry: Entry): string {
  return entry.change === "offered" ? entry.upstream : entry.tool;
}

const MARK: Record<Entry["change"], string> = {
  offered: "+",
  added: "+",
  changed: "~",
  removed: "-",
};

function changedSummary(
  entry: ChangedEntry,
  withheld: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  if (entry.version.served !== entry.version.proposed) {
    parts.push(`${entry.version.served} → ${entry.version.proposed}`);
  }
  if (entry.breaking.length > 0) {
    parts.push(
      withheld.has(entry.tool) ? "breaking, withheld until merge" : "breaking",
    );
  } else if (withheld.has(entry.tool)) {
    parts.push("input changed, withheld until merge");
  } else if (entry.description !== undefined) {
    parts.push("description changed, serving the locked one");
  }
  return parts.join(" ".repeat(COLUMN_GAP));
}

function changedDetails(entry: ChangedEntry): string[] {
  const lines = [
    ...entry.breaking.map((change) => change.detail),
    ...entry.notes,
  ];
  if (entry.description !== undefined) {
    lines.push(`- ${oneLine(entry.description.served)}`);
    lines.push(`+ ${oneLine(entry.description.proposed)}`);
  }
  return lines;
}

function summaryOf(
  entry: Entry,
  input: SyncPullRequestText,
  withheld: ReadonlySet<string>,
): string {
  switch (entry.change) {
    case "offered":
      return `new ${offeredNoun(input.sourceType)}, not imported`;
    case "added":
      return `new in the lock, version ${entry.version}`;
    case "changed":
      return changedSummary(entry, withheld);
    case "removed":
      return withheld.has(entry.tool)
        ? "breaking, withheld until merge"
        : "breaking";
  }
}

function detailsOf(entry: Entry): string[] {
  switch (entry.change) {
    case "offered":
    case "added":
      return [];
    case "changed":
      return changedDetails(entry);
    case "removed":
      return [
        ...entry.breaking.map((change) => change.detail),
        ...entry.notes,
      ];
  }
}

/** The order the diff lists entries in: new, changed, then removed. */
const ORDER: Record<Entry["change"], number> = {
  offered: 0,
  added: 1,
  changed: 2,
  removed: 3,
};

/** The tool surface diff as plain text, in the spec's format. */
export function renderDiff(input: SyncPullRequestText): string {
  const withheld = new Set(input.withheld);
  const entries = [...input.diff.entries].sort(
    (a, b) =>
      ORDER[a.change] - ORDER[b.change] ||
      nameOf(a).localeCompare(nameOf(b), "en"),
  );
  const width =
    Math.max(0, ...entries.map((entry) => nameOf(entry).length)) + COLUMN_GAP;
  const lines = [
    `${TOOL_SERVERS_DIR}/${input.server}  ${oneLine(input.origin)}`,
    "",
  ];
  for (const entry of entries) {
    const summary = summaryOf(entry, input, withheld);
    const head = `  ${MARK[entry.change]} ${nameOf(entry)}`;
    lines.push(
      summary.length > 0
        ? `${head.padEnd(width + 4)}${summary}`
        : head,
    );
    for (const detail of detailsOf(entry)) lines.push(`      ${detail}`);
  }
  if (entries.length === 0) lines.push("  (no tool changed)");
  const { served, proposed, budget } = input.diff.tokens;
  lines.push(
    "",
    `Definitions: ${count(served)} → ${count(proposed)} tokens per request (budget ${count(budget)})`,
  );
  return lines.join("\n");
}

/** A code fence longer than any run of backticks in the text. */
function fenced(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- \`${item}\``).join("\n");
}

export function syncTitle(input: SyncPullRequestText): string {
  return input.version === undefined
    ? `Sync ${input.server} with its source`
    : `Sync ${input.server} with version ${input.version.to}`;
}

export function syncBody(input: SyncPullRequestText): string {
  const folder = `${TOOL_SERVERS_DIR}/${input.server}`;
  const sections: string[] = [];
  const intro = [
    `Discovery found that the source of ${input.label} (\`${folder}\`) no longer matches its lock. This steering PR carries the new lock.`,
  ];
  if (input.version !== undefined) {
    intro.push(
      `It also moves source.version in server.toml from ${input.version.from} to ${input.version.to}, so the lock and the version change together.`,
    );
  }
  sections.push(intro.join(" "), fenced(renderDiff(input)));

  if (input.withheld.length > 0) {
    sections.push(
      [
        "The gateway withholds these tools until this PR merges, because a call built for the old definition may do something else:",
        "",
        bullets(input.withheld),
      ].join("\n"),
    );
  } else {
    sections.push(
      "No tool is withheld. The gateway serves the locked definitions until this PR merges.",
    );
  }

  if (input.dropped.length > 0) {
    sections.push(
      [
        "tools.toml still imports these tools, and the source no longer offers them in a form that compiles. The new lock leaves them out. Remove each from tools.toml before merge, or the compile check fails:",
        "",
        bullets(input.dropped),
      ].join("\n"),
    );
  }

  if (input.diff.entries.some((entry) => entry.change === "offered")) {
    sections.push(
      "New tools are listed and left unimported. To import one, add it to tools.toml on this branch.",
    );
  }

  const run = [
    `Discovery ran on ${TRIGGER_TEXT[input.trigger]} at ${utcText(input.at)}.`,
  ];
  if (input.machine !== null) {
    run.push(`Machine ${input.machine} reported the tools.`);
  }
  sections.push(run.join(" "));
  return `${sections.join("\n\n")}\n`;
}

export function syncCommitMessage(input: SyncPullRequestText): string {
  const tally = new Map<Entry["change"], number>();
  for (const entry of input.diff.entries) {
    tally.set(entry.change, (tally.get(entry.change) ?? 0) + 1);
  }
  const parts = (
    [
      ["changed", "changed"],
      ["removed", "removed"],
      ["added", "added"],
      ["offered", "offered and not imported"],
    ] as const
  )
    .filter(([change]) => (tally.get(change) ?? 0) > 0)
    .map(([change, text]) => `${tally.get(change) ?? 0} ${text}`);
  const lines = [syncTitle(input), ""];
  lines.push(
    parts.length > 0
      ? `Tools: ${parts.join(", ")}.`
      : "No tool changed. The lock records the new source.",
  );
  if (input.withheld.length > 0) {
    lines.push(`Withheld until merge: ${input.withheld.join(", ")}.`);
  }
  return `${lines.join("\n")}\n`;
}
