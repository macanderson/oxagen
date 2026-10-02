// workspace.ts: how the Memories tab and promote_memories read workspace
// memories (memory-collection spec, Memories tab and Promotion; ADR-248).
//
// Pure. workspace-store.ts reads the rows, and the handlers pass them here
// to name each memory's harness, to group memories that say the same thing,
// and to shape each row as the contracts answer it. A promoted draft's force
// follows `forcesFor` and `defaultForceFor` in steering-repo/record-force.ts,
// the rule the record wizard and the Markdown import read.
import type {
  WorkspaceMemory,
  WorkspaceMemoryGroup,
} from "@oxagen/oxagen/contracts/steering.memories.shared";
import { tachoHarnessSchema } from "@oxagen/oxagen/tacho/schemas";
import type { z } from "zod";
import { memoryShard } from "./naming";
import { jaccard, SAYS_SAME_MIN, statementWords, type StatementWords } from "./statement";
import type { MemoryCapture } from "./types";
import type { WorkspaceMemoryRow } from "./workspace-store";

export type MemoryHarness = z.output<typeof tachoHarnessSchema>;

const HARNESSES: readonly MemoryHarness[] = tachoHarnessSchema.options;

/**
 * The harnesses that report when an agent used one of their memories: a
 * Claude Code run that read the file, Codex's own count, and a Stella
 * citation. Any other harness shows "No signal", so a zero never reads as
 * unused.
 */
const USE_SIGNAL_HARNESSES: ReadonlySet<MemoryHarness> = new Set<MemoryHarness>([
  "claude-code",
  "codex",
  "stella",
]);

/**
 * The harness whose store holds a memory: the `<harness>:` that starts a
 * `local_gateway` source. A memory from remember_lesson, a pull request, or
 * an import lives in no harness, so its harness is null.
 */
export function harnessOf(
  capture: MemoryCapture,
  source: string | null,
): MemoryHarness | null {
  if (capture !== "local_gateway" || source === null) return null;
  const colon = source.indexOf(":");
  if (colon <= 0) return null;
  const name = source.slice(0, colon);
  return HARNESSES.find((harness) => harness === name) ?? null;
}

/** Does the memory's harness report its uses? */
export function hasUseSignal(harness: MemoryHarness | null): boolean {
  return harness !== null && USE_SIGNAL_HARNESSES.has(harness);
}

/** The fields grouping reads. A stored memory row carries them all. */
export interface GroupableMemory {
  statement: string;
  statementHash: string;
  repos: readonly string[] | null;
}

/** Memories that say the same thing, the highest ranked one first. */
export interface MemoryGroup<T extends GroupableMemory> {
  representative: T;
  members: T[];
}

/**
 * Group memories already in ranking order, the way the curator groups its
 * batch (`groupMemories` in curate.ts): inside one repository, a memory joins
 * the first group whose first memory has the same statement hash or says the
 * same thing, or it starts a group. The groups come back in the order they
 * started, so the group of the highest ranked memory comes first.
 *
 * Each statement's words are read once, so a page of 2,000 memories compares
 * word sets and never tokenizes a statement twice.
 */
export function groupRankedMemories<T extends GroupableMemory>(
  ranked: readonly T[],
): MemoryGroup<T>[] {
  interface Open {
    group: MemoryGroup<T>;
    words: StatementWords;
  }
  const groups: MemoryGroup<T>[] = [];
  const byShard = new Map<string, Open[]>();
  const byHash = new Map<string, Open>();
  for (const memory of ranked) {
    const shard = memoryShard(memory.repos === null ? null : [...memory.repos]);
    const hashKey = `${shard}\n${memory.statementHash}`;
    const sameHash = byHash.get(hashKey);
    if (sameHash !== undefined) {
      sameHash.group.members.push(memory);
      continue;
    }
    const words = statementWords(memory.statement);
    const shardGroups = byShard.get(shard) ?? [];
    byShard.set(shard, shardGroups);
    const found = shardGroups.find(
      (open) =>
        open.words.negated === words.negated &&
        jaccard(open.words.words, words.words) >= SAYS_SAME_MIN,
    );
    if (found !== undefined) {
      found.group.members.push(memory);
      byHash.set(hashKey, found);
      continue;
    }
    const started: Open = {
      group: { representative: memory, members: [memory] },
      words,
    };
    shardGroups.push(started);
    byHash.set(hashKey, started);
    groups.push(started.group);
  }
  return groups;
}

/** A memory row as the workspace memory contracts answer it. */
export function memoryView(row: WorkspaceMemoryRow): WorkspaceMemory {
  const harness = harnessOf(row.capture, row.source);
  return {
    id: row.publicId,
    label: row.label,
    summary: row.summary,
    statement: row.statement,
    state: row.state,
    capture: row.capture,
    harness,
    agent: row.agentLineage,
    source: row.source,
    repos: row.repos,
    memory_type: row.memoryType,
    kind: row.kind,
    use_count: row.useCount,
    use_signal: hasUseSignal(harness),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    promoted_lineage: row.promotedLineage,
    memory_pr:
      row.memoryPr === null
        ? null
        : {
            number: row.memoryPr.number,
            url: row.memoryPr.url,
            status: row.memoryPr.status,
          },
  };
}

/**
 * Group ranked rows and answer one page of groups. A group's uses add its
 * members' uses, and its last use is the newest of theirs.
 */
export function groupPage(
  ranked: readonly WorkspaceMemoryRow[],
  offset: number,
  limit: number,
): { groups: WorkspaceMemoryGroup[]; total: number } {
  const groups = groupRankedMemories(ranked);
  const page = groups.slice(offset, offset + limit).map((group) => {
    const members = group.members.map(memoryView);
    const newest = group.members.reduce<Date | null>(
      (latest, member) =>
        member.lastUsedAt !== null &&
        (latest === null || member.lastUsedAt > latest)
          ? member.lastUsedAt
          : latest,
      null,
    );
    return {
      memory: members[0] as WorkspaceMemory,
      members,
      use_count: group.members.reduce((sum, member) => sum + member.useCount, 0),
      last_used_at: newest?.toISOString() ?? null,
    };
  });
  return { groups: page, total: groups.length };
}
