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
  // Real duration-snapping logic is covered by @oxagen/ai's own tests; these
  // mirror its behaviour for the veo/sora catalog so handler tests match reality.
  resolveVideoDurationSeconds: (modelId: string, requested?: number) => {
    const supported = modelId.startsWith("google/veo")
      ? [4, 6, 8]
      : modelId.startsWith("openai/sora-2")
        ? [4, 8, 12]
        : undefined;
    if (!supported) {
      return {
        effectiveSeconds: requested,
        requestedSeconds: requested,
        adjusted: false,
      };
    }
    if (requested === undefined) {
      return {
        effectiveSeconds: supported[0],
        adjusted: false,
        supportedSeconds: supported,
      };
    }
    if (supported.includes(requested)) {
      return {
        effectiveSeconds: requested,
        requestedSeconds: requested,
        adjusted: false,
        supportedSeconds: supported,
      };
    }
    const nearest = supported.reduce((best, d) =>
      Math.abs(d - requested) < Math.abs(best - requested) ||
      (Math.abs(d - requested) === Math.abs(best - requested) && d > best)
        ? d
        : best,
    );
    return {
      effectiveSeconds: nearest,
      requestedSeconds: requested,
      adjusted: true,
      supportedSeconds: supported,
    };
  },
  videoDurationAlternatives: (requested: number, currentModelId?: string) =>
    [
      { model: "google/veo", supportedSeconds: [4, 6, 8] },
      { model: "openai/sora-2", supportedSeconds: [4, 8, 12] },
    ]
      .filter((entry) => !currentModelId?.startsWith(entry.model))
      .map((entry) => ({
        ...entry,
        closestSeconds: entry.supportedSeconds.reduce((best, d) =>
          Math.abs(d - requested) < Math.abs(best - requested) ? d : best,
        ),
      })),
}));

vi.mock("./generated-asset.persist", () => ({
  createPendingGeneratedAsset: mocks.createPendingGeneratedAsset,
}));

vi.mock("./event-client", () => ({
  eventClient: {
    send: mocks.inngestSend,
  },
}));

import { videoGenerateHandler } from "./video.generate";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

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
    mocks.requireEnv.mockImplementationOnce(() => {
      throw new Error("missing");
    });
    await expect(
      videoGenerateHandler({ prompt: "Ocean waves" }, CTX),
    ).rejects.toThrow("AI_GATEWAY_API_KEY is not configured");
  });

  // ── auth guard ──────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      videoGenerateHandler({ prompt: "Test" }, anonCtx),
    ).rejects.toThrow("video.generate requires an authenticated user");
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

  it("dispatches a supported durationSeconds unchanged", async () => {
    await videoGenerateHandler({ prompt: "Waves", durationSeconds: 6 }, CTX);
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.durationSeconds).toBe(6);
  });

  it("snaps an unsupported durationSeconds and reports the adjustment", async () => {
    const result = await videoGenerateHandler(
      { prompt: "Epic", durationSeconds: 30 },
      CTX,
    );

    // The render is still queued — at the nearest supported duration.
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.durationSeconds).toBe(8);
    expect(result.status).toBe("queued");

    // The structured adjustment tells the agent what happened and which models
    // get closer to the original request.
    expect(result.durationAdjustment).toEqual({
      requestedSeconds: 30,
      effectiveSeconds: 8,
      supportedSeconds: [4, 6, 8],
      alternatives: [
        {
          model: "openai/sora-2",
          supportedSeconds: [4, 8, 12],
          closestSeconds: 12,
        },
      ],
    });

    // The chat UI gets a human-readable notice.
    expect(result.render.props.notice).toContain("generating 8s");
    expect(result.render.props.notice).toContain("requested 30s");
    expect(result.render.props.notice).toContain("openai/sora-2");
  });

  it("defaults an absent durationSeconds to the model's shortest, with no adjustment notice", async () => {
    const result = await videoGenerateHandler({ prompt: "Short" }, CTX);
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.durationSeconds).toBe(4);
    expect(result.durationAdjustment).toBeUndefined();
    expect(result.render.props.notice).toBeUndefined();
  });

  it("uses an explicit input.model over the tier default", async () => {
    await videoGenerateHandler(
      { prompt: "Sora", model: "openai/sora-2", durationSeconds: 12 },
      CTX,
    );
    expect(mocks.videoTierModelId).not.toHaveBeenCalled();
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.model).toBe("openai/sora-2");
    expect(sentEvent.data.durationSeconds).toBe(12);
  });

  it("passes aspectRatio to inngest when provided", async () => {
    await videoGenerateHandler({ prompt: "Waves", aspectRatio: "9:16" }, CTX);
    const sentEvent = mocks.inngestSend.mock.calls[0]![0];
    expect(sentEvent.data.aspectRatio).toBe("9:16");
  });

  it("returns a unique jobId per call", async () => {
    mocks.createPendingGeneratedAsset
      .mockResolvedValueOnce({
        id: "uuid-1",
        publicId: "vas_1",
        serveUrl: "/api/v1/assets/vas_1",
      })
      .mockResolvedValueOnce({
        id: "uuid-2",
        publicId: "vas_2",
        serveUrl: "/api/v1/assets/vas_2",
      });

    const a = await videoGenerateHandler({ prompt: "A" }, CTX);
    const b = await videoGenerateHandler({ prompt: "B" }, CTX);
    expect(a.jobId).not.toBe(b.jobId);
  });
});
