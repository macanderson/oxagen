import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  experimentalGenerateVideo: vi.fn(),
  insertTokenUsage: vi.fn(),
  providerFromModelId: vi.fn(),
  chargeVideoCredits: vi.fn(),
  videoProviderCostUsdMicros: vi.fn(),
  gatewayVideo: vi.fn(),
}));

// Default: resolves with a single video whose uint8Array + mimeType mirror the
// shape of GenerateVideoResult.video (a GeneratedFile).
const FAKE_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
const FAKE_MIME = "video/mp4";

mocks.experimentalGenerateVideo.mockResolvedValue({
  video: { uint8Array: FAKE_BYTES, mimeType: FAKE_MIME },
  videos: [{ uint8Array: FAKE_BYTES, mimeType: FAKE_MIME }],
  warnings: [],
  responses: [],
  providerMetadata: {},
});
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.providerFromModelId.mockReturnValue("google");
mocks.videoProviderCostUsdMicros.mockReturnValue(1_750_000);
mocks.chargeVideoCredits.mockResolvedValue({
  costUsdMicros: 1_750_000,
  creditsMetered: 1n,
  creditsCharged: 1n,
  shortfallCredits: 0n,
});
mocks.gatewayVideo.mockReturnValue({ modelId: "google/veo-3.0-fast-generate-001" });

vi.mock("ai", () => ({
  experimental_generateVideo: mocks.experimentalGenerateVideo,
}));

vi.mock("@ai-sdk/gateway", () => ({
  gateway: { video: mocks.gatewayVideo },
}));

vi.mock("@oxagen/telemetry", () => ({
  insertTokenUsage: mocks.insertTokenUsage,
  providerFromModelId: mocks.providerFromModelId,
}));

vi.mock("@oxagen/billing", () => ({
  chargeVideoCredits: mocks.chargeVideoCredits,
  videoProviderCostUsdMicros: mocks.videoProviderCostUsdMicros,
}));

import { generateVideoFor } from "./generate-video";

// ─────────────────────────────────────────────────────────────────────────────

const FAKE_MODEL = { modelId: "google/veo-3.0-fast-generate-001" } as Parameters<
  typeof generateVideoFor
>[0]["model"];

const TELEMETRY = {
  orgId: "org_1",
  workspaceId: "ws_1",
  surface: "app" as const,
  executionStepId: "asset_abc",
};

beforeEach(() => {
  mocks.experimentalGenerateVideo.mockClear();
  mocks.insertTokenUsage.mockClear();
  mocks.providerFromModelId.mockClear();
  mocks.chargeVideoCredits.mockClear();
  mocks.videoProviderCostUsdMicros.mockClear();
  // restore defaults
  mocks.experimentalGenerateVideo.mockResolvedValue({
    video: { uint8Array: FAKE_BYTES, mimeType: FAKE_MIME },
    videos: [{ uint8Array: FAKE_BYTES, mimeType: FAKE_MIME }],
    warnings: [],
    responses: [],
    providerMetadata: {},
  });
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.providerFromModelId.mockReturnValue("google");
  mocks.videoProviderCostUsdMicros.mockReturnValue(1_750_000);
  mocks.chargeVideoCredits.mockResolvedValue({
    costUsdMicros: 1_750_000,
    creditsMetered: 1n,
    creditsCharged: 1n,
    shortfallCredits: 0n,
  });
});

describe("generateVideoFor (@oxagen/ai)", () => {
  it("returns bytes and mimeType from the first generated video", async () => {
    const result = await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "A sunset timelapse",
      telemetry: TELEMETRY,
    });

    expect(result.bytes).toBe(FAKE_BYTES);
    expect(result.mimeType).toBe("video/mp4");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes prompt, duration, and aspectRatio through to experimental_generateVideo", async () => {
    await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "Waves crashing on a beach",
      durationSeconds: 5,
      aspectRatio: "16:9",
      telemetry: TELEMETRY,
    });

    expect(mocks.experimentalGenerateVideo).toHaveBeenCalledTimes(1);
    const arg = mocks.experimentalGenerateVideo.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.prompt).toBe("Waves crashing on a beach");
    expect(arg.duration).toBe(5);
    expect(arg.aspectRatio).toBe("16:9");
    expect(arg.maxRetries).toBe(0);
  });

  it("writes a token_usage row with the correct telemetry fields", async () => {
    await generateVideoFor({ model: FAKE_MODEL, prompt: "test", telemetry: TELEMETRY });

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("org_1");
    expect(row.workspace_id).toBe("ws_1");
    expect(row.surface).toBe("app");
    expect(row.execution_step_id).toBe("asset_abc");
    expect(row.input_tokens).toBe(1);
    expect(row.output_tokens).toBe(0);
    expect(row.cached_tokens).toBe(0);
    expect(row.prompt_hash).toBe("video-generation");
    expect(typeof row.duration_ms).toBe("number");
  });

  it("charges the org's credits through the billing gate", async () => {
    await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "test",
      durationSeconds: 5,
      telemetry: TELEMETRY,
    });

    expect(mocks.chargeVideoCredits).toHaveBeenCalledTimes(1);
    const chargeArg = mocks.chargeVideoCredits.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(chargeArg.orgId).toBe("org_1");
    expect(chargeArg.referenceId).toBe("asset_abc");
    expect(chargeArg.model).toBe("google/veo-3.0-fast-generate-001");
    expect(chargeArg.durationSeconds).toBe(5);
  });

  it("swallows an insertTokenUsage error and still returns bytes", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("CH down"));

    const result = await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(result.bytes).toBe(FAKE_BYTES);
  });

  it("swallows a chargeVideoCredits error and still returns bytes", async () => {
    mocks.chargeVideoCredits.mockRejectedValueOnce(new Error("billing down"));

    const result = await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(result.bytes).toBe(FAKE_BYTES);
  });

  it("propagates errors from experimental_generateVideo (not swallowed)", async () => {
    mocks.experimentalGenerateVideo.mockRejectedValueOnce(new Error("provider error"));

    await expect(
      generateVideoFor({ model: FAKE_MODEL, prompt: "fail", telemetry: TELEMETRY }),
    ).rejects.toThrow("provider error");
  });

  it("defaults mimeType to video/mp4 when provider omits it", async () => {
    mocks.experimentalGenerateVideo.mockResolvedValueOnce({
      video: { uint8Array: FAKE_BYTES, mimeType: undefined },
      videos: [{ uint8Array: FAKE_BYTES, mimeType: undefined }],
      warnings: [],
      responses: [],
      providerMetadata: {},
    });

    const result = await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "no mime",
      telemetry: TELEMETRY,
    });

    expect(result.mimeType).toBe("video/mp4");
  });

  it("calls providerFromModelId with the resolved model id", async () => {
    await generateVideoFor({ model: FAKE_MODEL, prompt: "test", telemetry: TELEMETRY });

    expect(mocks.providerFromModelId).toHaveBeenCalledTimes(1);
    expect(mocks.providerFromModelId).toHaveBeenCalledWith("google/veo-3.0-fast-generate-001");
  });

  it("resolves model id from a string model arg", async () => {
    await generateVideoFor({
      model: "google/veo-3.0-generate-001",
      prompt: "string model id",
      telemetry: TELEMETRY,
    });

    expect(mocks.providerFromModelId).toHaveBeenCalledWith("google/veo-3.0-generate-001");
  });
});
