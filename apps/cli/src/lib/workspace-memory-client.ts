/**
 * Transport and formatters for workspace memories: the memories agents wrote
 * in their harnesses' own stores, which Oxagen collects from enrolled hosts
 * (memory-collection spec; ADR-248).
 *
 * `oxagen memory list|show|promote|dismiss` call the org-scoped routes of
 * list_workspace_memories, get_workspace_memory, promote_memories, and
 * dismiss_memories through `apiPostOrThrow`. The shapes are the contracts'
 * own output types.
 */
import type { SteeringMemoriesDismissOutput } from "@oxagen/oxagen/contracts/steering.memories.dismiss";
import type { SteeringMemoriesGetOutput } from "@oxagen/oxagen/contracts/steering.memories.get";
import type { SteeringMemoriesListOutput } from "@oxagen/oxagen/contracts/steering.memories.list";
import type { SteeringMemoriesPromoteOutput } from "@oxagen/oxagen/contracts/steering.memories.promote";
import type {
  MemoryDraftRecord,
  WorkspaceMemory,
  WorkspaceMemoryState,
} from "@oxagen/oxagen/contracts/steering.memories.shared";
import { apiPostOrThrow } from "./api.js";

export type {
  SteeringMemoriesDismissOutput,
  SteeringMemoriesGetOutput,
  SteeringMemoriesListOutput,
  SteeringMemoriesPromoteOutput,
};

/** The routes, under /v1/<org>/<workspace>/. */
const ROUTES = {
  list: "context/steering/memories/list",
  get: "context/steering/memories/get",
  promote: "context/steering/memories/promote",
  dismiss: "context/steering/memories/dismiss",
} as const;

export const WORKSPACE_MEMORY_STATES: readonly WorkspaceMemoryState[] = [
  "waiting",
  "in_pr",
  "promoted",
  "dismissed",
  "retired",
];

export interface ListWorkspaceMemoriesOptions {
  states?: WorkspaceMemoryState[];
  harness?: string;
  agent?: string;
  repository?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

/** list_workspace_memories. Unset filters are left out, so the server's defaults apply. */
export async function listWorkspaceMemories(
  opts: ListWorkspaceMemoriesOptions = {},
): Promise<SteeringMemoriesListOutput> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts))
    if (value !== undefined) body[key] = value;
  return apiPostOrThrow<SteeringMemoriesListOutput>(ROUTES.list, body);
}

/** get_workspace_memory. */
export async function getWorkspaceMemory(
  memoryId: string,
): Promise<SteeringMemoriesGetOutput> {
  return apiPostOrThrow<SteeringMemoriesGetOutput>(ROUTES.get, {
    memory_id: memoryId,
  });
}

/** promote_memories. */
export async function promoteWorkspaceMemories(input: {
  drafts: MemoryDraftRecord[];
  same_text: boolean;
}): Promise<SteeringMemoriesPromoteOutput> {
  return apiPostOrThrow<SteeringMemoriesPromoteOutput>(ROUTES.promote, input);
}

/** dismiss_memories. */
export async function dismissWorkspaceMemories(input: {
  memory_ids: string[];
  restore: boolean;
}): Promise<SteeringMemoriesDismissOutput> {
  return apiPostOrThrow<SteeringMemoriesDismissOutput>(ROUTES.dismiss, input);
}

// ── Formatters ──────────────────────────────────────────────────────────────

const STATE_LABELS: Record<WorkspaceMemoryState, string> = {
  waiting: "Waiting",
  in_pr: "In PR",
  promoted: "Promoted",
  dismissed: "Dismissed",
  retired: "Retired",
};

function truncate(text: string, max: number): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

/** The memory's name: its label, or its statement's first line. */
function memoryName(memory: WorkspaceMemory): string {
  return memory.label ?? memory.statement.split("\n")[0] ?? memory.statement;
}

/** Uses as a count, or "No signal" for a harness that reports none. */
function usesText(count: number, signal: boolean): string {
  return signal || count > 0 ? String(count) : "No signal";
}

/** An ISO time as a short relative age against `now`, such as `3h ago`. */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "Never";
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ");
  return [line(headers), ...rows.map(line)];
}

/** The list as a table, one row per group, then the page and the waiting count. */
export function formatWorkspaceMemories(
  result: SteeringMemoriesListOutput,
  now: Date = new Date(),
): string {
  if (result.groups.length === 0) {
    return result.total_groups === 0
      ? "No memories yet. Oxagen collects them from enrolled hosts every five minutes."
      : `No memories on this page. The list holds ${plural(result.total_groups, "group", "groups")}.`;
  }
  const rows = result.groups.map((group) => {
    const { memory } = group;
    const same = group.members.length - 1;
    const name = truncate(memoryName(memory), 60);
    return [
      memory.id,
      usesText(group.use_count, group.members.some((m) => m.use_signal)),
      ago(group.last_used_at, now),
      memory.harness ?? "None",
      STATE_LABELS[memory.state],
      same > 0 ? `${name} (+${same} same)` : name,
    ];
  });
  const lines = table(["ID", "Uses", "Last used", "Harness", "State", "Memory"], rows);
  const shown = result.groups.length;
  lines.push(
    "",
    shown < result.total_groups
      ? `Showing ${shown} of ${plural(result.total_groups, "group", "groups")}. Use --limit and --offset to page.`
      : `${plural(result.total_groups, "group", "groups")}.`,
  );
  if (result.truncated)
    lines.push(
      `More than ${result.total_memories} memories matched, and the list groups the top ${result.total_memories}. Narrow the filters to see the rest.`,
    );
  lines.push(`${plural(result.waiting, "memory waits", "memories wait")} in this workspace.`);
  return lines.join("\n");
}

/** One memory in full: its text, where it came from, its uses, and its memory PR. */
export function formatWorkspaceMemory(
  result: SteeringMemoriesGetOutput,
  now: Date = new Date(),
): string {
  const { memory, uses, uses_total, memory_pr } = result;
  const lines = [
    `Memory ${memory.id}`,
    `  Name:       ${memoryName(memory)}`,
    `  State:      ${STATE_LABELS[memory.state]}${memory.retired_reason === null ? "" : ` (${memory.retired_reason})`}`,
    `  Harness:    ${memory.harness ?? "None"}`,
    `  Agent:      ${memory.agent ?? "Unknown"}`,
    `  Source:     ${memory.source ?? "None"}`,
    `  Type:       ${memory.memory_type ?? "None"}`,
    `  Kind:       ${memory.kind}`,
    `  Uses:       ${usesText(memory.use_count, memory.use_signal)}`,
    `  Last used:  ${ago(memory.last_used_at, now)}`,
    `  Captured:   ${memory.created_at}`,
  ];
  if (memory.repos !== null) lines.push(`  Repos:      ${memory.repos.join(", ")}`);
  if (memory.promoted_lineage !== null)
    lines.push(`  Record:     ${memory.promoted_lineage}`);
  if (memory_pr !== null)
    lines.push(
      `  Memory PR:  #${memory_pr.number} (${memory_pr.status}) ${memory_pr.url}`,
    );
  lines.push("", memory.statement.trim());
  if (uses.length > 0) {
    lines.push("", `Uses (${uses.length < uses_total ? `${uses.length} of ${uses_total}` : uses_total}):`);
    for (const use of uses)
      lines.push(
        `  ${use.used_at}  ${use.signal}  ${use.run ?? "no run"}${use.count > 1 ? `  x${use.count}` : ""}`,
      );
  }
  return lines.join("\n");
}

const SKIP_REASONS: Record<SteeringMemoriesPromoteOutput["skipped"][number]["reason"], string> = {
  not_found: "this workspace holds no such memory",
  not_waiting: "the memory is not waiting",
  already_proposed: "an open memory PR already proposes its statement",
};

/** What promotion did: the memory PR, each record it added, and each memory it left out. */
export function formatPromoteResult(result: SteeringMemoriesPromoteOutput): string {
  const lines: string[] = [];
  if (result.pull_request === null) {
    lines.push("No record was added, because no memory you named can be promoted.");
  } else {
    const pr = result.pull_request;
    lines.push(
      `${pr.opened ? "Opened" : "Added to"} memory PR #${pr.number} on ${pr.branch}: ${pr.url}`,
    );
    for (const record of result.records)
      lines.push(
        `  ${record.path} (${record.kind}, ${record.force}${record.effect === null ? "" : `, ${record.effect}`}) cites ${record.memory_ids.join(", ")}`,
      );
    lines.push("Nothing steers until a person merges the PR.");
  }
  for (const skip of result.skipped)
    lines.push(`Skipped ${skip.memory_id}: ${SKIP_REASONS[skip.reason]}.`);
  return lines.join("\n");
}

/** Why a dismissal or a restore left a memory in its state. */
const SKIPPED_STATES: Record<WorkspaceMemoryState, string> = {
  waiting: "it is waiting",
  in_pr: "a memory PR cites it",
  promoted: "a steering record carries it",
  dismissed: "it is already dismissed",
  retired: "it is retired",
};

/** What a dismissal or a restore changed. */
export function formatDismissResult(
  result: SteeringMemoriesDismissOutput,
  restore: boolean,
): string {
  const lines: string[] = [];
  if (result.changed.length > 0)
    lines.push(
      `${restore ? "Restored" : "Dismissed"} ${plural(result.changed.length, "memory", "memories")}: ${result.changed.join(", ")}.`,
    );
  else lines.push(`No memory was ${restore ? "restored" : "dismissed"}.`);
  if (!restore && result.rejections > 0)
    lines.push("The curator proposes their statements again only after memories from 2 more runs repeat them.");
  for (const skip of result.skipped)
    lines.push(
      `Skipped ${skip.memory_id}: ${skip.state === null ? "this workspace holds no such memory" : SKIPPED_STATES[skip.state]}.`,
    );
  return lines.join("\n");
}

