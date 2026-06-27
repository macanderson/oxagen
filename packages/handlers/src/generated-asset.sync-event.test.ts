/**
 * Unit tests for emitGeneratedFileSyncEvent.
 *
 * Covers: event shape, embed-source selection (contentText > prompt),
 * best-effort embed + send, and the EmbedTextOpts telemetry contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_EMBEDDING = new Array(1536).fill(0.42);

const { mockSend, mockEmbedText } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockEmbedText: vi.fn(),
}));

vi.mock("./event-client", () => ({ eventClient: { send: mockSend } }));
vi.mock("@oxagen/ai", () => ({ embedText: mockEmbedText }));

import { emitGeneratedFileSyncEvent } from "./generated-asset.sync-event";

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  mockEmbedText.mockResolvedValue(FAKE_EMBEDDING);
});

const base = {
  assetId: "11111111-1111-1111-1111-111111111111",
  publicId: "gen_abc",
  orgId: "org-1",
  workspaceId: "ws-1",
  kind: "document",
  mimeType: "text/markdown",
  model: "local",
  displayName: "USS Nautilus: Polar Crossing",
};

describe("emitGeneratedFileSyncEvent — event shape", () => {
  it("fires content/generated-asset.sync with mapped fields", async () => {
    await emitGeneratedFileSyncEvent({
      ...base,
      prompt: "Generate markdown: USS Nautilus: Polar Crossing",
      conversationId: "conv-1",
      messageId: "msg-1",
      contentText: "USS Nautilus completed the first submerged transit of the North Pole.",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const payload = mockSend.mock.calls[0]![0] as { name: string; data: Record<string, unknown> };
    expect(payload.name).toBe("content/generated-asset.sync");
    expect(payload.data).toMatchObject({
      assetId: base.assetId,
      publicId: "gen_abc",
      orgId: "org-1",
      workspaceId: "ws-1",
      kind: "document",
      mimeType: "text/markdown",
      model: "local",
      displayName: "USS Nautilus: Polar Crossing",
      conversationId: "conv-1",
      messageId: "msg-1",
    });
    expect(payload.data.embedding).toEqual(FAKE_EMBEDDING);
    expect(typeof payload.data.summary).toBe("string");
  });

  it("defaults optional linkage fields to null", async () => {
    await emitGeneratedFileSyncEvent(base);
    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.conversationId).toBeNull();
    expect(payload.data.messageId).toBeNull();
    expect(payload.data.prompt).toBeNull();
  });
});

describe("emitGeneratedFileSyncEvent — embed source", () => {
  it("embeds the decoded content for text assets (prefers content over prompt)", async () => {
    await emitGeneratedFileSyncEvent({
      ...base,
      prompt: "Generate markdown: USS Nautilus: Polar Crossing",
      contentText: "The North Pole transit happened in August 1958.",
    });
    const [text, opts] = mockEmbedText.mock.calls[0]! as [
      string,
      { telemetry: { orgId: string; workspaceId: string; surface: string; executionStepId: string | null } },
    ];
    expect(text).toContain("USS Nautilus: Polar Crossing"); // displayName
    expect(text).toContain("North Pole transit"); // content
    expect(text).toContain("(document)"); // kind hint
    expect(opts.telemetry.orgId).toBe("org-1");
    expect(opts.telemetry.surface).toBe("runner");
    // executionStepId MUST be null — a synthesized string breaks the UUID columns.
    expect(opts.telemetry.executionStepId).toBeNull();
  });

  it("falls back to the prompt when there is no text content (binary asset)", async () => {
    await emitGeneratedFileSyncEvent({
      ...base,
      kind: "image",
      mimeType: "image/png",
      displayName: "a calico cat",
      prompt: "a fluffy calico cat sitting on a windowsill",
      contentText: null,
    });
    const [text] = mockEmbedText.mock.calls[0]! as [string];
    expect(text).toContain("a calico cat");
    expect(text).toContain("windowsill");
  });

  it("stores the embed text as summary (snippet source)", async () => {
    await emitGeneratedFileSyncEvent({ ...base, contentText: "hello world" });
    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.summary as string).toContain("hello world");
  });
});

describe("emitGeneratedFileSyncEvent — best-effort", () => {
  it("emits with embedding: null when embedText fails", async () => {
    mockEmbedText.mockRejectedValueOnce(new Error("AI gateway timeout"));
    await expect(emitGeneratedFileSyncEvent(base)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledOnce();
    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.embedding).toBeNull();
  });

  it("swallows a send failure instead of throwing", async () => {
    mockSend.mockRejectedValueOnce(new Error("inngest unavailable"));
    await expect(emitGeneratedFileSyncEvent(base)).resolves.toBeUndefined();
  });
});
