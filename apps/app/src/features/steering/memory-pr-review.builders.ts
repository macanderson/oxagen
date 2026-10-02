// Typed memory PR records for the memory PR review tests (#4518): the branch
// the records sit on, a record with the memories it cites, and one memory.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { MemoryPrRecord } from "./memory-pr-review";

type MemoryPrMemory = MemoryPrRecord["memories"][number];

/** The memory branch the sample records sit on. */
export const MEMORY_BRANCH = "memory/2026-09-27-release-lessons";

/** The sample memory PR's number, which drop_memory_record names it by. */
export const MEMORY_PR_NUMBER = 12;

/** One memory an agent recorded in a ledger run, with the frame it saw. */
export function memoryPrMemory(
  overrides: Partial<MemoryPrMemory> = {},
): MemoryPrMemory {
  return {
    id: "mem_01k5rw3changelog",
    statement: "The changelog did not change between the two reads.",
    agent: "release-bot",
    run: "arun_01k5rs7m",
    evidence: ["frame:arun_01k5rs7m/14"],
    state: "in_pr",
    ...overrides,
  };
}

/** One record the memory PR proposes, not dropped. */
export function memoryPrRecord(
  overrides: Partial<MemoryPrRecord> = {},
): MemoryPrRecord {
  return {
    action: "propose",
    path: ".oxagen/memory/release.no-reread-changelog.toml",
    lineage: "mem.release.no-reread-changelog",
    kind: "memory",
    title: "Do not re-read the changelog",
    summary: "Read CHANGELOG.md once per release run.",
    memories: [memoryPrMemory()],
    dropped: null,
    ...overrides,
  };
}
