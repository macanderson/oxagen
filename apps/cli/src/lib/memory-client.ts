/**
 * Typed client + formatters for the workspace AgentMemory capabilities.
 *
 * Wraps the org-scoped /v1 routes (agent/memory/list|remember|update|delete) the
 * API exposes for the memory contracts. Every call goes through `apiPostOrThrow`
 * so both the one-shot `oxagen memory`/`oxagen remember` subcommands and the
 * interactive REPL slash commands (/remember, /memories, /forget) share one
 * transport and one set of formatters — no drift between the surfaces.
 */
import { apiPostOrThrow } from "./api.js";

export type MemoryWeight = "low" | "high" | "critical";
export type MemoryKind =
  | "routine-change"
  | "constraint"
  | "bug-root-cause"
  | "convention-deviation"
  | "gotcha";

/** Mirror of the shared agentMemoryRecordSchema returned by the API. */
export interface MemoryRecord {
  id: string;
  publicId: string;
  nodeRef: string;
  weight: MemoryWeight;
  kind: string;
  lesson: string;
  source: string;
  confidence: number;
  createdAt: string;
  lastReinforcedAt: string | null;
}

export interface MemoryListResult {
  memories: MemoryRecord[];
  total: number;
}

export interface RememberResult {
  memory: MemoryRecord;
  inferred: { kind: MemoryKind; weight: MemoryWeight; classified: boolean };
}

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "routine-change",
  "constraint",
  "bug-root-cause",
  "convention-deviation",
  "gotcha",
];
export const MEMORY_WEIGHTS: readonly MemoryWeight[] = ["low", "high", "critical"];

export interface ListMemoriesOptions {
  kind?: MemoryKind;
  minWeight?: MemoryWeight;
  nodeRef?: string;
  limit?: number;
  offset?: number;
}

/** List the workspace's memories, newest first, with optional filters. */
export async function listMemories(
  opts: ListMemoriesOptions = {},
): Promise<MemoryListResult> {
  return apiPostOrThrow<MemoryListResult>("agent/memory/list", {
    kind: opts.kind,
    minWeight: opts.minWeight,
    nodeRef: opts.nodeRef,
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
  });
}

export interface RememberOptions {
  text: string;
  nodeRef?: string;
  weight?: MemoryWeight;
  kind?: MemoryKind;
  source?: "user" | "feature" | "fix" | "exception-watcher" | "bug-report";
  relatedNodeIds?: string[];
}

/** Capture a free-text memory; the server infers kind+weight unless pinned. */
export async function rememberMemory(opts: RememberOptions): Promise<RememberResult> {
  return apiPostOrThrow<RememberResult>("agent/memory/remember", opts);
}

export interface UpdateMemoryOptions {
  memoryId: string;
  lesson?: string;
  weight?: MemoryWeight;
  kind?: MemoryKind;
  source?: string;
  confidence?: number;
}

/** Edit a memory's lesson, kind, source, or salience (weight + confidence). */
export async function updateMemory(opts: UpdateMemoryOptions): Promise<MemoryRecord> {
  return apiPostOrThrow<MemoryRecord>("agent/memory/update", opts);
}

/** Permanently delete a memory by id. */
export async function deleteMemory(
  memoryId: string,
): Promise<{ deleted: boolean; memoryId: string }> {
  return apiPostOrThrow<{ deleted: boolean; memoryId: string }>("agent/memory/delete", {
    memoryId,
  });
}

// ── Formatters (shared by the CLI subcommands and the REPL slash commands) ──────

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** A one-line id reference: short id with the kind/weight badges. */
function badges(m: MemoryRecord): string {
  return `${m.weight}/${m.kind}`;
}

/**
 * Render a memory list as an aligned table string (so the REPL can print it via
 * the TUI and the CLI can write it to stdout from the same code).
 */
export function formatMemoryLines(result: MemoryListResult): string {
  if (result.memories.length === 0) {
    return "No memories yet. Capture one with `/remember <text>` (or `oxagen remember \"…\"`).";
  }
  const rows = result.memories.map((m) => {
    const id = m.id.slice(0, 8);
    const conf = m.confidence.toFixed(2);
    return `${id}  ${badges(m).padEnd(26)} ${conf}  ${truncate(m.lesson, 64)}`;
  });
  const header = `${"id".padEnd(8)}  ${"weight/kind".padEnd(26)} ${"conf"}  lesson`;
  const shown = result.memories.length;
  const footer =
    result.total > shown
      ? `\nShowing ${shown} of ${result.total}. Use --limit / --offset to page.`
      : `\n${result.total} ${result.total === 1 ? "memory" : "memories"}.`;
  return [header, ...rows].join("\n") + footer;
}

/** Render a single memory in full detail. */
export function formatMemoryDetail(m: MemoryRecord): string {
  return [
    `Memory ${m.id}`,
    `  lesson:     ${m.lesson}`,
    `  kind:       ${m.kind}`,
    `  weight:     ${m.weight}`,
    `  confidence: ${m.confidence.toFixed(2)}`,
    `  source:     ${m.source}`,
    `  nodeRef:    ${m.nodeRef || "(none)"}`,
    `  created:    ${m.createdAt}`,
    `  reinforced: ${m.lastReinforcedAt ?? "(never)"}`,
    `  publicId:   ${m.publicId}`,
  ].join("\n");
}

/** Render the result of a /remember capture. */
export function formatRememberResult(r: RememberResult): string {
  const how = r.inferred.classified ? "inferred" : "set";
  return (
    `✓ Remembered — kind ${r.inferred.kind}, weight ${r.inferred.weight} (${how}).\n` +
    `  id: ${r.memory.id}\n` +
    `  ${truncate(r.memory.lesson, 100)}`
  );
}
