import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  emitGraphSync,
  setGraphSyncClient,
  clearGraphSyncClientForTests,
  type GraphSyncEventClient,
  type GraphSyncEvent,
} from "./emit-sync";

describe("emitGraphSync", () => {
  let mockClient: GraphSyncEventClient;
  let sentEvents: GraphSyncEvent[];

  beforeEach(() => {
    sentEvents = [];
    mockClient = {
      send: vi.fn(async (event: GraphSyncEvent) => {
        sentEvents.push(event);
      }),
    };
    clearGraphSyncClientForTests();
  });

  it("silently does nothing when no client is configured", async () => {
    // No client set — should not throw
    await expect(
      emitGraphSync({
        recordId: "abc123",
        orgId: "org-1",
        workspaceId: "ws-1",
        nodeRef: "file:main.ts",
        entityRefs: null,
        body: "test",
        kind: "episodic",
        salience: 0.5,
      }),
    ).resolves.toBeUndefined();
  });

  it("sends the event when client is configured", async () => {
    setGraphSyncClient(mockClient);

    await emitGraphSync({
      recordId: "abc123",
      orgId: "org-1",
      workspaceId: "ws-1",
      nodeRef: "file:main.ts",
      entityRefs: ["kn-1", "kn-2"],
      body: "The auth module uses JWT",
      kind: "semantic",
      salience: 0.7,
    });

    expect(mockClient.send).toHaveBeenCalledOnce();
    expect(sentEvents[0]!.name).toBe("engram/memory.graph-sync");
    expect(sentEvents[0]!.data.recordId).toBe("abc123");
    expect(sentEvents[0]!.data.nodeRef).toBe("file:main.ts");
    expect(sentEvents[0]!.data.entityRefs).toEqual(["kn-1", "kn-2"]);
  });

  it("swallows errors from the client (best-effort)", async () => {
    const failingClient: GraphSyncEventClient = {
      send: vi.fn(async () => {
        throw new Error("Inngest is down");
      }),
    };
    setGraphSyncClient(failingClient);

    // Should not throw
    await expect(
      emitGraphSync({
        recordId: "def456",
        orgId: "org-1",
        workspaceId: "ws-1",
        nodeRef: null,
        entityRefs: null,
        body: "test",
        kind: "episodic",
        salience: 0.3,
      }),
    ).resolves.toBeUndefined();
  });

  it("stops sending after clearGraphSyncClientForTests()", async () => {
    setGraphSyncClient(mockClient);
    clearGraphSyncClientForTests();

    await emitGraphSync({
      recordId: "ghi789",
      orgId: "org-1",
      workspaceId: "ws-1",
      nodeRef: "file:x.ts",
      entityRefs: null,
      body: "test",
      kind: "episodic",
      salience: 0.3,
    });

    expect(mockClient.send).not.toHaveBeenCalled();
  });
});
