/**
 * An in-memory `EpisodicStore` for driving the provider without DuckDB.
 *
 * The real adapter needs a native module that is an optional dependency, so a
 * suite that required it would be a suite that silently skipped wherever the
 * module was absent. The provider only ever calls four of the store's methods,
 * and those four are implemented here with the same semantics the DuckDB
 * adapter documents; the rest reject rather than returning a plausible empty
 * value, so a provider change that starts calling one fails loudly instead of
 * passing against a stub that agreed with it.
 *
 * Exported from `src/testing/` rather than a `__mocks__` directory because
 * `stdio.test.ts` runs it in a child process, which needs a real import path.
 */
import type { DecayStats } from "@oxagen/engram";
import type { MemoryRecord, Namespace } from "@oxagen/engram";
import type { EpisodicQuery, EpisodicStore } from "@oxagen/engram/store";

function notUsed(method: string): never {
  throw new Error(
    `FakeEpisodicStore.${method} is not implemented: the provider did not call it when this fake was written.`,
  );
}

/** Matches the adapter's rule: org + workspace scope, session/agent ignored. */
function sameWorkspace(a: Namespace, b: Namespace): boolean {
  return a.org === b.org && a.workspace === b.workspace;
}

export class FakeEpisodicStore implements EpisodicStore {
  private readonly records: MemoryRecord[];

  constructor(records: readonly MemoryRecord[] = []) {
    this.records = [...records];
  }

  query(opts: EpisodicQuery): Promise<MemoryRecord[]> {
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
    const matched = this.records
      .filter((record) => sameWorkspace(record.namespace, opts.namespace))
      .filter((record) => (kinds ? kinds.has(record.kind) : true))
      .filter((record) =>
        opts.before === undefined ? true : record.createdAt <= opts.before,
      )
      .filter((record) =>
        opts.after === undefined ? true : record.createdAt >= opts.after,
      )
      .filter((record) =>
        opts.minSalience === undefined
          ? true
          : record.salience >= opts.minSalience,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    const offset = opts.offset ?? 0;
    return Promise.resolve(matched.slice(offset, offset + opts.limit));
  }

  getById(id: string): Promise<MemoryRecord | null> {
    return Promise.resolve(this.records.find((r) => r.id === id) ?? null);
  }

  getByIds(ids: string[]): Promise<MemoryRecord[]> {
    const wanted = new Set(ids);
    return Promise.resolve(this.records.filter((r) => wanted.has(r.id)));
  }

  /**
   * The adapter's contract: the fraction of query tokens the record's body
   * matches, case-insensitively, as a substring.
   */
  searchLexical(
    namespace: Namespace,
    query: string,
    limit: number,
  ): Promise<Array<{ recordId: string; score: number }>> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return Promise.resolve([]);
    const scored = this.records
      .filter((record) => sameWorkspace(record.namespace, namespace))
      .map((record) => {
        const text = JSON.stringify(record.body).toLowerCase();
        const hit = terms.filter((term) => text.includes(term)).length;
        return { recordId: record.id, score: hit / terms.length };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || (a.recordId < b.recordId ? -1 : 1));
    return Promise.resolve(scored.slice(0, limit));
  }

  append(): Promise<void> {
    return notUsed("append");
  }
  appendBatch(): Promise<void> {
    return notUsed("appendBatch");
  }
  recent(): Promise<MemoryRecord[]> {
    return notUsed("recent");
  }
  listNamespaces(): Promise<Namespace[]> {
    return notUsed("listNamespaces");
  }
  updateSalience(): Promise<void> {
    return notUsed("updateSalience");
  }
  reinforce(): Promise<void> {
    return notUsed("reinforce");
  }
  readDecayStats(): Promise<Map<string, DecayStats>> {
    return notUsed("readDecayStats");
  }
  updateConfidence(): Promise<void> {
    return notUsed("updateConfidence");
  }
  evictExpired(): Promise<number> {
    return notUsed("evictExpired");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A record with sane defaults, so a test states only what it is about. */
export function fakeRecord(
  overrides: Partial<MemoryRecord> & { id: string },
): MemoryRecord {
  return {
    kind: "semantic",
    namespace: { org: "acme", workspace: "platform" },
    body: { text: "a remembered thing" },
    salience: 0.5,
    confidence: 0.9,
    provenance: {
      author: "agent:test",
      derivedFrom: [],
      timestamp: 1_700_000_000_000,
    },
    causality: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as MemoryRecord;
}
