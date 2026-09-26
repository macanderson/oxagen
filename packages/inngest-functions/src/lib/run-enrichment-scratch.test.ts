/**
 * The transcript chunks one run-enrichment job keeps as scratch objects
 * (#3784): what the manifest names, what a cleanup deletes, what a read
 * step that runs again leaves behind, and what a read checks a chunk
 * against.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  objects: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  written: [] as string[],
  deleted: [] as string[],
  /** Set to make every read fail the way a storage outage does. */
  outage: false,
}));

vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({
    putScratch: async (input: {
      jobRunId: string;
      name: string;
      contentType: string;
      bytes: Uint8Array;
    }) => {
      store.objects.set(`${input.jobRunId}/${input.name}`, {
        bytes: input.bytes,
        contentType: input.contentType,
      });
      store.written.push(input.name);
    },
    getScratch: async (_scope: unknown, jobRunId: string, name: string) => {
      if (store.outage) throw new Error("blob store answered 503");
      const object = store.objects.get(`${jobRunId}/${name}`);
      if (object) return object;
      throw Object.assign(new Error(`no object ${name}`), {
        name: "StorageNotFoundError",
      });
    },
    deleteScratch: async (
      _scope: unknown,
      jobRunId: string,
      names: readonly string[],
    ) => {
      for (const name of names) {
        store.objects.delete(`${jobRunId}/${name}`);
        store.deleted.push(name);
      }
    },
  }),
}));
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));

import { NonRetriableError } from "@oxagen/functions";
import { digestBytes } from "@oxagen/tacho";
import {
  discardEnrichmentChunks,
  ENRICHMENT_MAX_CHUNKS,
  enrichmentScratchCount,
  keepEnrichmentChunks,
  readEnrichmentChunk,
} from "./run-enrichment-scratch";
import {
  ENRICHMENT_CHUNK_CHARS,
  ENRICHMENT_TEXT_CEILING_CHARS,
} from "./run-enrichment";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const JOB = "01K5ZJ3N9Q8R7S6T5V4W3X2Y1Z";

beforeEach(() => {
  store.objects.clear();
  store.written = [];
  store.deleted = [];
  store.outage = false;
});

describe("the chunks one enrichment job keeps", () => {
  it("writes the manifest before the chunks, and reads each chunk back", async () => {
    const kept = await keepEnrichmentChunks(SCOPE, JOB, ["first", "second"]);
    expect(kept.scratch).toBe(2);
    expect(store.written).toEqual(["manifest", "chunk-0", "chunk-1"]);
    expect(await readEnrichmentChunk(SCOPE, JOB, 1, kept.digests[1])).toBe(
      "second",
    );
    expect(await enrichmentScratchCount(SCOPE, JOB)).toBe(2);
  });

  it("keeps the larger count when the read step runs again with fewer chunks", async () => {
    await keepEnrichmentChunks(SCOPE, JOB, ["a", "b", "c"]);
    // The second attempt wrote one chunk; the first attempt's other two
    // are still named, so the cleanup deletes them too.
    expect((await keepEnrichmentChunks(SCOPE, JOB, ["a"])).scratch).toBe(3);
    await discardEnrichmentChunks(SCOPE, JOB);
    expect(store.objects.size).toBe(0);
    expect(store.deleted).toEqual(["chunk-0", "chunk-1", "chunk-2", "manifest"]);
  });

  it("writes nothing for a job with no chunks to keep (negative)", async () => {
    expect(await keepEnrichmentChunks(SCOPE, JOB, [])).toEqual({
      scratch: 0,
      digests: [],
    });
    expect(store.written).toEqual([]);
  });

  it("deletes by the count it is given without reading the manifest", async () => {
    await keepEnrichmentChunks(SCOPE, JOB, ["a", "b"]);
    store.outage = true;
    await discardEnrichmentChunks(SCOPE, JOB, 2);
    expect(store.deleted).toEqual(["chunk-0", "chunk-1", "manifest"]);
  });

  it("deletes nothing for a job that kept nothing (negative)", async () => {
    await discardEnrichmentChunks(SCOPE, JOB);
    expect(store.deleted).toEqual([]);
  });

  it("deletes every name a job could write when its manifest is unreadable", async () => {
    store.objects.set(`${JOB}/manifest`, {
      bytes: new TextEncoder().encode("not json"),
      contentType: "application/json",
    });
    expect(await enrichmentScratchCount(SCOPE, JOB)).toBe(
      ENRICHMENT_MAX_CHUNKS,
    );
    await discardEnrichmentChunks(SCOPE, JOB);
    expect(store.deleted).toHaveLength(ENRICHMENT_MAX_CHUNKS + 1);
    expect(store.deleted.at(-1)).toBe("manifest");
  });

  it("throws a storage failure rather than forgetting what to delete (negative)", async () => {
    await keepEnrichmentChunks(SCOPE, JOB, ["a"]);
    store.outage = true;
    await expect(discardEnrichmentChunks(SCOPE, JOB)).rejects.toThrow("503");
    expect(store.deleted).toEqual([]);
  });

  it("answers each chunk's digest for the read step, and reads back a chunk that matches it", async () => {
    const kept = await keepEnrichmentChunks(SCOPE, JOB, ["first", "second"]);
    expect(kept.digests).toEqual([
      digestBytes("first"),
      digestBytes("second"),
    ]);
    expect(await readEnrichmentChunk(SCOPE, JOB, 0, kept.digests[0])).toBe(
      "first",
    );
  });

  // Review round 2 on #4382: the digest a read checked came from the
  // manifest, a scratch object at a key anyone who writes scratch can name.
  // The manifest now holds the count alone, and a read neither fetches nor
  // trusts it: the digest comes from the read step's output.
  it("keeps no digest in the manifest, and reads a chunk without fetching the manifest (negative)", async () => {
    const kept = await keepEnrichmentChunks(SCOPE, JOB, ["first", "second"]);
    const manifest = store.objects.get(`${JOB}/manifest`);
    expect(JSON.parse(new TextDecoder().decode(manifest?.bytes))).toEqual({
      chunks: 2,
    });
    // A manifest rewritten to vouch for other bytes changes nothing.
    store.objects.set(`${JOB}/manifest`, {
      bytes: new TextEncoder().encode(
        JSON.stringify({ chunks: 2, digests: [digestBytes("forged")] }),
      ),
      contentType: "application/json",
    });
    store.objects.set(`${JOB}/chunk-0`, {
      bytes: new TextEncoder().encode("forged"),
      contentType: "text/plain",
    });
    await expect(
      readEnrichmentChunk(SCOPE, JOB, 0, kept.digests[0]),
    ).rejects.toThrow("does not match the digest its read step recorded");
    // With the manifest gone, a chunk that matches still reads.
    store.objects.delete(`${JOB}/manifest`);
    expect(await readEnrichmentChunk(SCOPE, JOB, 1, kept.digests[1])).toBe(
      "second",
    );
  });

  // Review round 1 on #4382: a read decrypted whatever scratch object sat at
  // a chunk's key. Every job's scratch is sealed under one KEK and the
  // envelope names no path, so another job's chunk read as this one's.
  // Review round 2 on #4382: the mismatch fails the same way on every retry,
  // so it ends the job rather than spending its retries.
  it("fails the read of a chunk whose bytes do not match its digest, for good (negative)", async () => {
    const kept = await keepEnrichmentChunks(SCOPE, JOB, ["first", "second"]);
    store.objects.set(`${JOB}/chunk-1`, {
      bytes: new TextEncoder().encode("another job's transcript"),
      contentType: "text/plain",
    });
    const read = readEnrichmentChunk(SCOPE, JOB, 1, kept.digests[1]);
    await expect(read).rejects.toBeInstanceOf(NonRetriableError);
    await expect(read).rejects.toThrow(
      "does not match the digest its read step recorded",
    );
    // The chunk that matches still reads.
    expect(await readEnrichmentChunk(SCOPE, JOB, 0, kept.digests[0])).toBe(
      "first",
    );
  });

  it("fails the read of a chunk with no digest to check, for good, before it fetches the chunk (negative)", async () => {
    await keepEnrichmentChunks(SCOPE, JOB, ["first"]);
    store.outage = true;
    const read = readEnrichmentChunk(SCOPE, JOB, 0, undefined);
    await expect(read).rejects.toBeInstanceOf(NonRetriableError);
    await expect(read).rejects.toThrow(
      "has no digest in its read step's output",
    );
  });

  it("checks a retried read step's chunks against the retry's digests", async () => {
    await keepEnrichmentChunks(SCOPE, JOB, ["a", "b", "c"]);
    const retry = await keepEnrichmentChunks(SCOPE, JOB, ["A"]);
    expect(retry.scratch).toBe(3);
    expect(retry.digests).toHaveLength(1);
    expect(await readEnrichmentChunk(SCOPE, JOB, 0, retry.digests[0])).toBe(
      "A",
    );
    // Chunk 1 is the first attempt's, named only so the cleanup deletes it.
    await expect(
      readEnrichmentChunk(SCOPE, JOB, 1, retry.digests[1]),
    ).rejects.toThrow("has no digest in its read step's output");
  });

  it("names one chunk past the text ceiling, for the note that says where it stops", () => {
    expect(ENRICHMENT_MAX_CHUNKS).toBe(
      ENRICHMENT_TEXT_CEILING_CHARS / ENRICHMENT_CHUNK_CHARS + 1,
    );
  });
});
