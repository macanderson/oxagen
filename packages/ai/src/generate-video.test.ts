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
mocks.gatewayVideo.mockReturnValue({
  modelId: "google/veo-3.0-fast-generate-001",
});

vi.mock("ai", () => ({
  experimental_generateVideo: mocks.experimentalGenerateVideo,
}));

vi.mock("@ai-sdk/gateway", () => ({
  gateway: { video: mocks.gatewayVideo },
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertTokenUsage: mocks.insertTokenUsage,
    providerFromModelId: mocks.providerFromModelId,
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    chargeVideoCredits: mocks.chargeVideoCredits,
    videoProviderCostUsdMicros: mocks.videoProviderCostUsdMicros,
  };
});

import { requireScope, runInTenantScope } from "@oxagen/tenancy";
import {
  generateVideoFor,
  supportedVideoDurations,
  resolveVideoDurationSeconds,
  videoDurationAlternatives,
} from "./generate-video";

// ─────────────────────────────────────────────────────────────────────────────

const FAKE_MODEL = {
  modelId: "google/veo-3.0-fast-generate-001",
} as Parameters<typeof generateVideoFor>[0]["model"];

const TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
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
      durationSeconds: 6,
      aspectRatio: "16:9",
      telemetry: TELEMETRY,
    });

    expect(mocks.experimentalGenerateVideo).toHaveBeenCalledTimes(1);
    const arg = mocks.experimentalGenerateVideo.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.prompt).toBe("Waves crashing on a beach");
    expect(arg.duration).toBe(6);
    expect(arg.aspectRatio).toBe("16:9");
    expect(arg.maxRetries).toBe(0);
  });

  it("snaps an unsupported duration to the nearest the model supports (30 → 8 for Veo)", async () => {
    const result = await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "A 30-second epic",
      durationSeconds: 30,
      telemetry: TELEMETRY,
    });

    const arg = mocks.experimentalGenerateVideo.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.duration).toBe(8);
    expect(result.effectiveDurationSeconds).toBe(8);
    // Billing must charge the effective duration, never the requested one.
    expect(mocks.videoProviderCostUsdMicros).toHaveBeenCalledWith(
      "google/veo-3.0-fast-generate-001",
      8,
    );
    const chargeArg = mocks.chargeVideoCredits.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(chargeArg.durationSeconds).toBe(8);
  });

  it("defaults an absent duration to the model's shortest supported (Veo → 4)", async () => {
    const result = await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "Default duration",
      telemetry: TELEMETRY,
    });

    const arg = mocks.experimentalGenerateVideo.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.duration).toBe(4);
    expect(result.effectiveDurationSeconds).toBe(4);
  });

  it("passes durations through untouched for models with no known constraint", async () => {
    await generateVideoFor({
      model: "acme/video-x",
      prompt: "Unknown model",
      durationSeconds: 30,
      telemetry: TELEMETRY,
    });

    const arg = mocks.experimentalGenerateVideo.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.duration).toBe(30);
  });

  it("writes a token_usage row with the correct telemetry fields", async () => {
    await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "test",
      telemetry: TELEMETRY,
    });

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(row.workspace_id).toBe("00000000-0000-4000-8000-000000000002");
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
      durationSeconds: 6,
      telemetry: TELEMETRY,
    });

    expect(mocks.chargeVideoCredits).toHaveBeenCalledTimes(1);
    const chargeArg = mocks.chargeVideoCredits.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(chargeArg.orgId).toBe("00000000-0000-4000-8000-000000000001");
    expect(chargeArg.referenceId).toBe("asset_abc");
    expect(chargeArg.model).toBe("google/veo-3.0-fast-generate-001");
    expect(chargeArg.durationSeconds).toBe(6);
  });

  // ── Tenant-scope regression (Inngest billing leak) ─────────────────────────
  // chargeVideoCredits → consumeCredits → withTenantDb → requireScope. When
  // generateVideoFor runs inside an Inngest function (no ambient tenant scope),
  // the old code charged scopeless → requireScope threw TenantScopeError → the
  // catch swallowed it → the render was never billed (a revenue leak). The
  // helper must now establish the scope from telemetry around the charge itself.
  // These mocks reproduce the real requireScope() gate so they FAIL on the old
  // code and PASS on the new.
  it("charges inside a tenant scope when none is ambient (Inngest path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeVideoCredits.mockImplementation(async () => {
      // Reproduces consumeCredits → withTenantDb → requireScope: throws
      // TenantScopeError when no scope is active.
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 1_750_000,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
      };
    });

    // Invoked with NO surrounding runInTenantScope — mirrors an Inngest worker.
    await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "inngest render",
      telemetry: TELEMETRY,
    });

    expect(mocks.chargeVideoCredits).toHaveBeenCalledTimes(1);
    expect(chargeSucceeded).toBe(true);
  });

  it("charges successfully when a tenant scope is already active (request path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeVideoCredits.mockImplementation(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 1_750_000,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
      };
    });

    await runInTenantScope(
      { orgId: TELEMETRY.orgId, workspaceId: TELEMETRY.workspaceId },
      async () => {
        await generateVideoFor({
          model: FAKE_MODEL,
          prompt: "request render",
          telemetry: TELEMETRY,
        });
      },
    );

    expect(chargeSucceeded).toBe(true);
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
    mocks.experimentalGenerateVideo.mockRejectedValueOnce(
      new Error("provider error"),
    );

    await expect(
      generateVideoFor({
        model: FAKE_MODEL,
        prompt: "fail",
        telemetry: TELEMETRY,
      }),
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
    await generateVideoFor({
      model: FAKE_MODEL,
      prompt: "test",
      telemetry: TELEMETRY,
    });

    expect(mocks.providerFromModelId).toHaveBeenCalledTimes(1);
    expect(mocks.providerFromModelId).toHaveBeenCalledWith(
      "google/veo-3.0-fast-generate-001",
    );
  });

  it("resolves model id from a string model arg", async () => {
    await generateVideoFor({
      model: "google/veo-3.0-generate-001",
      prompt: "string model id",
      telemetry: TELEMETRY,
    });

    expect(mocks.providerFromModelId).toHaveBeenCalledWith(
      "google/veo-3.0-generate-001",
    );
  });
});

describe("supportedVideoDurations", () => {
  it("resolves Veo variants by prefix", () => {
    expect(supportedVideoDurations("google/veo-3.0-fast-generate-001")).toEqual(
      [4, 6, 8],
    );
    expect(supportedVideoDurations("google/veo-3.1")).toEqual([4, 6, 8]);
  });

  it("resolves Sora variants by prefix", () => {
    expect(supportedVideoDurations("openai/sora-2")).toEqual([4, 8, 12]);
    expect(supportedVideoDurations("openai/sora-2-pro")).toEqual([4, 8, 12]);
  });

  it("returns undefined for unknown models", () => {
    expect(supportedVideoDurations("acme/video-x")).toBeUndefined();
  });
});

describe("resolveVideoDurationSeconds", () => {
  it("keeps a supported duration unchanged", () => {
    expect(resolveVideoDurationSeconds("google/veo-3.0", 6)).toEqual({
      effectiveSeconds: 6,
      requestedSeconds: 6,
      adjusted: false,
      supportedSeconds: [4, 6, 8],
    });
  });

  it("snaps an unsupported duration to the nearest supported", () => {
    expect(
      resolveVideoDurationSeconds("google/veo-3.0", 30).effectiveSeconds,
    ).toBe(8);
    expect(resolveVideoDurationSeconds("google/veo-3.0", 30).adjusted).toBe(
      true,
    );
    expect(
      resolveVideoDurationSeconds("openai/sora-2", 30).effectiveSeconds,
    ).toBe(12);
  });

  it("resolves ties toward the longer clip (Veo 5 → 6)", () => {
    expect(
      resolveVideoDurationSeconds("google/veo-3.0", 5).effectiveSeconds,
    ).toBe(6);
  });

  it("selects the shortest supported duration when none is requested", () => {
    const resolved = resolveVideoDurationSeconds("google/veo-3.0");
    expect(resolved.effectiveSeconds).toBe(4);
    expect(resolved.adjusted).toBe(false);
  });

  it("passes unknown models through untouched", () => {
    expect(resolveVideoDurationSeconds("acme/video-x", 30)).toEqual({
      effectiveSeconds: 30,
      requestedSeconds: 30,
      adjusted: false,
    });
    expect(
      resolveVideoDurationSeconds("acme/video-x").effectiveSeconds,
    ).toBeUndefined();
  });
});

describe("videoDurationAlternatives", () => {
  it("ranks other models by closeness to the requested duration", () => {
    const alts = videoDurationAlternatives(
      30,
      "google/veo-3.0-fast-generate-001",
    );
    expect(alts[0]?.model).toBe("openai/sora-2");
    expect(alts[0]?.closestSeconds).toBe(12);
    expect(alts.some((a) => a.model === "google/veo")).toBe(false);
  });

  it("includes every known model when no current model is given", () => {
    const alts = videoDurationAlternatives(10);
    expect(alts.map((a) => a.model)).toContain("google/veo");
    expect(alts.map((a) => a.model)).toContain("openai/sora-2");
  });
});
