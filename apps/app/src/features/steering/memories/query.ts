// The two reads the Memories tab makes (memory-collection spec, Memories
// tab; #4914), and what the tab draws from the first.
//
// The first read takes every memory in every state. Each filter lists only
// the values those memories hold, the tab tells "No memories yet" apart from
// a filter that matches nothing, and the Promote dialog names the memory PR
// a draft joins. The second read is the page the filters name. Both rank by
// uses, then the newest use, then the newest capture, on the server.
import {
  type MemoryHarness,
  WORKSPACE_MEMORY_STATES,
  type WorkspaceMemoryPage,
  type WorkspaceMemoryQuery,
} from "@/data/contracts/steering";
import { type MemoriesView, memoryStates } from "../view";

/** The most groups one read answers: list_workspace_memories' `limit` bound. */
const MEMORY_READ_MAX = 200;

/** Every memory in every state, with no filter, up to the read's bound. */
export const EVERY_MEMORY: WorkspaceMemoryQuery = {
  states: WORKSPACE_MEMORY_STATES,
  harness: null,
  agent: null,
  repository: null,
  type: null,
  limit: MEMORY_READ_MAX,
  offset: 0,
};

/** The page the filters, the offset and the page size name. */
export function pageQuery(
  view: MemoriesView,
  offset: number,
  rows: number,
): WorkspaceMemoryQuery {
  return {
    states: memoryStates(view.state),
    harness: view.harness,
    agent: view.agent,
    repository: view.repo,
    type: view.type,
    limit: rows,
    offset,
  };
}

/** The values each filter offers: the ones the memories hold, sorted. */
export type MemoryFacets = {
  harness: MemoryHarness[];
  agent: string[];
  repo: string[];
  type: string[];
};

export function facetsOf(page: WorkspaceMemoryPage): MemoryFacets {
  const harness = new Set<MemoryHarness>();
  const agent = new Set<string>();
  const repo = new Set<string>();
  const type = new Set<string>();
  for (const group of page.groups) {
    for (const memory of group.members) {
      if (memory.harness !== null) harness.add(memory.harness);
      if (memory.agent !== null) agent.add(memory.agent);
      for (const r of memory.repos ?? []) repo.add(r);
      if (memory.memoryType !== null) type.add(memory.memoryType);
    }
  }
  const sorted = <T extends string>(values: Set<T>): T[] =>
    [...values].sort((a, b) => a.localeCompare(b));
  return {
    harness: sorted(harness),
    agent: sorted(agent),
    repo: sorted(repo),
    type: sorted(type),
  };
}

/**
 * The memory PR a new draft joins: the open one a memory cites. Null when no
 * memory cites an open one, and Promote then opens a memory PR.
 */
export function openMemoryPr(page: WorkspaceMemoryPage): number | null {
  for (const group of page.groups) {
    for (const memory of group.members) {
      if (memory.memoryPr?.status === "open") return memory.memoryPr.number;
    }
  }
  return null;
}
