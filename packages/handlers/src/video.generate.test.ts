import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ──────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  requireEnv: vi.fn(),
  createPendingGeneratedAsset: vi.fn(),
  inngestSend: vi.fn(),
  videoTierModelId: vi.fn(),
}));

// Default: gateway key present, pending asset created, inngest queued.
mocks.requireEnv.mockReturnValue({ AI_GATEWAY_API_KEY: "test-key" });
mocks.videoTierModelId.mockReturnValue("google/veo-3.0");
mocks.createPendingGeneratedAsset.mockResolvedValue({
  id: "uuid-asset-1",
  publicId: "vas_ABC",
  serveUrl: "/api/v1/assets/vas_ABC",
});
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/config/env", () => ({
  requireEnv: mocks.requireEnv,
}));

vi.mock("@oxagen/ai", () => ({
  videoTierModelId: mocks.videoTierModelId,
}));

vi.mock("./generated-asset.persist", () => ({
  createPendingGeneratedAsset: mocks.createPendingGeneratedAsset,
}));

vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: {
    send: mocks.inngestSend,
  },
}));

import { videoGenerateHandler } from "./video.generate";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────
<<<<<<< HEAD

import { TEST_CTX as CTX } from "./test-utils/fixtures";

=======

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

>>>>>>> feat/hardening-cost-prompts-motion-rebrand
describe("videoGenerateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireEnv.mockReturnValue({ AI_GATEWAY_API_KEY: "test-key" });
    mocks.videoTierModelId.mockReturnValue("google/veo-3.0");
    mocks.createPendingGeneratedAsset.mockResolvedValue({
      id: "uuid-asset-1",
      publicId: "vas_ABC",
      serveUrl: "/api/v1/assets/vas_ABC",
    });
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  // ── gateway key absent ──────────────────────────────────────────────────────

  it("throws when AI_GATEWAY_API_KEY is not configured", async () => {
    mocks.requireEnv.mockImplementationOnce(() => { throw new Error("missing"); });
    await expect(videoGenerateHandler({ prompt: "Ocean waves" }, CTX)).rejects.toThrow(
      "AI_GATEWAY_API_KEY is not configured",
    );
  });

  // ── auth guard ──────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(videoGenerateHandler({ prompt: "Test" }, anonCtx)).rejects.toThrow(
      "video.generate requires an authenticated user",
    );
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it("returns status: queued, jobId, serveUrl, and render directive", async () => {
    const result = await videoGenerateHandler({ prompt: "Ocean waves" }, CTX);
    expect(result.status).toBe("queued");
    expect(result.jobId).toBe("vas_ABC");
    expect(result.serveUrl).toBe("/api/v1/assets/vas_ABC");
    expect(result.render.componentId).toBe("video-result");
    expect(result.render.props.prompt).toBe("Ocean waves");
    expect(result.render.props.url).toBe("/api/v1/assets/vas_ABC");
  });

  it("creates a pending asset row before queuing render", async () => {
    await videoGenerateHandler({ prompt: "Forest" }, CTX);
    expect(mocks.createPendingGeneratedAsset).toHaveBeenCalledTimes(1);
  });

  it("dispatches the inngest render event after creating the asset", async () => {
    await videoGenerateHandler({ prompt: "Forest" }, CTX);
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.name).toBe("agent/video.render");
    expect(sentEvent.data.prompt).toBe("Forest");
  });

  it("passes durationSeconds to inngest when provided", async () => {
    await videoGenerateHandler({ prompt: "Waves", durationSeconds: 20 }, CTX);
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.durationSeconds).toBe(20);
  });

  it("passes aspectRatio to inngest when provided", async () => {
    await videoGenerateHandler({ prompt: "Waves", aspectRatio: "9:16" }, CTX);
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.aspectRatio).toBe("9:16");
  });

  it("returns a unique jobId per call", async () => {
    mocks.createPendingGeneratedAsset
      .mockResolvedValueOnce({ id: "uuid-1", publicId: "vas_1", serveUrl: "/api/v1/assets/vas_1" })
      .mockResolvedValueOnce({ id: "uuid-2", publicId: "vas_2", serveUrl: "/api/v1/assets/vas_2" });

    const a = await videoGenerateHandler({ prompt: "A" }, CTX);
    const b = await videoGenerateHandler({ prompt: "B" }, CTX);
    expect(a.jobId).not.toBe(b.jobId);
  });
});
