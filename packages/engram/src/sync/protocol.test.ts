/**
 * Tests for sync/protocol.ts — syncWithPeer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncWithPeer, type SyncPeer } from "./protocol";
import { buildMerkleTree } from "./merkle";
import { createRecord } from "../record";
import type { Namespace, Provenance, MemoryRecord } from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = { author: "test", derivedFrom: [], timestamp: Date.now() };

function makeRecord(event: string): MemoryRecord {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: {} },
    salience: 0.5,
    confidence: 1.0,
    provenance: PROV,
  });
}

function makePeer(overrides: Partial<SyncPeer> = {}): SyncPeer {
  return {
    getRootHash: vi.fn(async () => "remote-hash"),
    getSubtree: vi.fn(async () => buildMerkleTree([])),
    pullRecords: vi.fn(async () => []),
    pushRecords: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("syncWithPeer", () => {
  let pullRecords: (ids: string[]) => Promise<MemoryRecord[]>;
  let storeRecords: (records: MemoryRecord[]) => Promise<void>;

  beforeEach(() => {
    pullRecords = vi.fn(async (_ids: string[]): Promise<MemoryRecord[]> => []);
    storeRecords = vi.fn(async (_records: MemoryRecord[]): Promise<void> => undefined);
  });

  it("returns zero counts when root hashes match (no sync needed)", async () => {
    const localTree = buildMerkleTree(["id-1", "id-2"]);
    const peer = makePeer({
      getRootHash: vi.fn(async () => localTree.hash),
    });

    const result = await syncWithPeer(["id-1", "id-2"], localTree, peer, NS, pullRecords, storeRecords);

    expect(result.recordsPulled).toBe(0);
    expect(result.recordsPushed).toBe(0);
    expect(result.bytesTransferred).toBe(0);
    expect(peer.getSubtree).not.toHaveBeenCalled();
  });

  it("pulls records present in remote but not in local", async () => {
    const localTree = buildMerkleTree(["id-1"]);
    const remoteRecord = makeRecord("remote-event");
    const remoteTree = buildMerkleTree(["id-1", remoteRecord.id]);

    const peer = makePeer({
      getRootHash: vi.fn(async () => remoteTree.hash),
      getSubtree: vi.fn(async () => remoteTree),
      pullRecords: vi.fn(async () => [remoteRecord]),
    });

    const result = await syncWithPeer(["id-1"], localTree, peer, NS, pullRecords, storeRecords);

    expect(result.recordsPulled).toBe(1);
    expect(storeRecords).toHaveBeenCalledWith([remoteRecord]);
    expect(result.bytesTransferred).toBeGreaterThan(0);
  });

  it("pushes records present in local but not in remote", async () => {
    const localRecord = makeRecord("local-event");
    const localTree = buildMerkleTree(["shared-id", localRecord.id]);
    const remoteTree = buildMerkleTree(["shared-id"]);

    const pushedRecords: MemoryRecord[] = [];
    pullRecords = vi.fn(async () => [localRecord]);
    const peer = makePeer({
      getRootHash: vi.fn(async () => remoteTree.hash),
      getSubtree: vi.fn(async () => remoteTree),
      pushRecords: vi.fn(async (records: MemoryRecord[]) => {
        pushedRecords.push(...records);
      }),
    });

    const result = await syncWithPeer([localRecord.id, "shared-id"], localTree, peer, NS, pullRecords, storeRecords);

    expect(result.recordsPushed).toBe(1);
    expect(peer.pushRecords).toHaveBeenCalled();
  });

  it("handles both pull and push in the same sync", async () => {
    const localRecord = makeRecord("local-only");
    const remoteRecord = makeRecord("remote-only");

    const localTree = buildMerkleTree(["shared", localRecord.id]);
    const remoteTree = buildMerkleTree(["shared", remoteRecord.id]);

    pullRecords = vi.fn(async () => [localRecord]);
    const peer = makePeer({
      getRootHash: vi.fn(async () => remoteTree.hash),
      getSubtree: vi.fn(async () => remoteTree),
      pullRecords: vi.fn(async () => [remoteRecord]),
      pushRecords: vi.fn(async () => undefined),
    });

    const result = await syncWithPeer(
      ["shared", localRecord.id],
      localTree,
      peer,
      NS,
      pullRecords,
      storeRecords,
    );

    expect(result.recordsPulled).toBe(1);
    expect(result.recordsPushed).toBe(1);
  });

  it("records duration in result", async () => {
    const localTree = buildMerkleTree([]);
    const peer = makePeer({
      getRootHash: vi.fn(async () => localTree.hash),
    });

    const result = await syncWithPeer([], localTree, peer, NS, pullRecords, storeRecords);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns conflictsDetected 0 (CRDT merge not yet implemented)", async () => {
    const localTree = buildMerkleTree(["id-1"]);
    const peer = makePeer({
      getRootHash: vi.fn(async () => localTree.hash),
    });

    const result = await syncWithPeer(["id-1"], localTree, peer, NS, pullRecords, storeRecords);

    expect(result.conflictsDetected).toBe(0);
  });

  it("tracks bytes transferred from pulled records", async () => {
    const localTree = buildMerkleTree([]);
    const remoteRecord = makeRecord("big-event");
    const remoteTree = buildMerkleTree([remoteRecord.id]);

    const peer = makePeer({
      getRootHash: vi.fn(async () => remoteTree.hash),
      getSubtree: vi.fn(async () => remoteTree),
      pullRecords: vi.fn(async () => [remoteRecord]),
    });

    const result = await syncWithPeer([], localTree, peer, NS, pullRecords, storeRecords);

    expect(result.bytesTransferred).toBeGreaterThan(0);
  });

  it("gets remote subtree at path []", async () => {
    const localTree = buildMerkleTree(["id-1"]);
    const remoteTree = buildMerkleTree(["id-1", "id-2"]);
    let capturedPath: number[] = [];

    const peer = makePeer({
      getRootHash: vi.fn(async () => remoteTree.hash),
      getSubtree: vi.fn(async (_ns: Namespace, path: number[]) => {
        capturedPath = path;
        return remoteTree;
      }),
    });

    await syncWithPeer(["id-1"], localTree, peer, NS, pullRecords, storeRecords);

    expect(capturedPath).toEqual([]);
  });
});
