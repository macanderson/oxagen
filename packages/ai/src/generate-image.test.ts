import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  insertTokenUsage: vi.fn(),
  providerFromModelId: vi.fn(),
  chargeImageCredits: vi.fn(),
  imageProviderCostUsdMicros: vi.fn(),
}));

const FAKE_B64 = "aGVsbG8="; // "hello"

mocks.generateImage.mockResolvedValue({ images: [{ base64: FAKE_B64 }] });
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.providerFromModelId.mockReturnValue("bfl");
mocks.imageProviderCostUsdMicros.mockReturnValue(80_000);
mocks.chargeImageCredits.mockResolvedValue({
  costUsdMicros: 80_000,
  creditsMetered: 1n,
  creditsCharged: 1n,
  shortfallCredits: 0n,
});

vi.mock("ai", () => ({ generateImage: mocks.generateImage }));

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
    chargeImageCredits: mocks.chargeImageCredits,
    imageProviderCostUsdMicros: mocks.imageProviderCostUsdMicros,
  };
});

import { requireScope, runInTenantScope } from "@oxagen/tenancy";
import { generateImageFor } from "./generate-image";

// ─────────────────────────────────────────────────────────────────────────────

// generateImageFor reads `.modelId` off the ImageModel for telemetry/billing.
const FAKE_MODEL = { modelId: "bfl/flux-2-max" } as Parameters<
  typeof generateImageFor
>[0]["model"];

const TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "app" as const,
  executionStepId: "msg_abc",
};

beforeEach(() => {
  mocks.generateImage.mockClear();
  mocks.insertTokenUsage.mockClear();
  mocks.providerFromModelId.mockClear();
  mocks.chargeImageCredits.mockClear();
  mocks.imageProviderCostUsdMicros.mockClear();
  mocks.generateImage.mockResolvedValue({ images: [{ base64: FAKE_B64 }] });
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.providerFromModelId.mockReturnValue("bfl");
  mocks.imageProviderCostUsdMicros.mockReturnValue(80_000);
  mocks.chargeImageCredits.mockResolvedValue({
    costUsdMicros: 80_000,
    creditsMetered: 1n,
    creditsCharged: 1n,
    shortfallCredits: 0n,
  });
});

describe("generateImageFor (@oxagen/ai)", () => {
  it("returns the base64 images and the image count", async () => {
    const result = await generateImageFor({
      model: FAKE_MODEL,
      prompt: "a bull",
      telemetry: TELEMETRY,
    });

    expect(result.images).toEqual([FAKE_B64]);
    expect(result.imageCount).toBe(1);
    expect(typeof result.durationMs).toBe("number");
  });

  it("writes a token_usage row tagged with the REAL model id (not a sentinel)", async () => {
    await generateImageFor({
      model: FAKE_MODEL,
      prompt: "a bull",
      telemetry: TELEMETRY,
    });

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.model).toBe("bfl/flux-2-max");
    expect(row.provider).toBe("bfl");
    expect(row.input_tokens).toBe(1); // image count
    expect(row.output_tokens).toBe(0);
    expect(row.cost_usd_micros).toBe(80_000);
    expect(row.prompt_hash).toBe("image-generation");
    expect(row.execution_step_id).toBe("msg_abc");
  });

  it("prices the real model + size and charges via chargeImageCredits", async () => {
    await generateImageFor({
      model: FAKE_MODEL,
      prompt: "a bull",
      size: "1536x1024",
      telemetry: TELEMETRY,
    });

    expect(mocks.imageProviderCostUsdMicros).toHaveBeenCalledWith(
      "bfl/flux-2-max",
      1,
      "1536x1024",
    );
    expect(mocks.chargeImageCredits).toHaveBeenCalledTimes(1);
    const chargeArg = mocks.chargeImageCredits.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(chargeArg.orgId).toBe("00000000-0000-4000-8000-000000000001");
    expect(chargeArg.referenceId).toBe("msg_abc");
    expect(chargeArg.model).toBe("bfl/flux-2-max");
    expect(chargeArg.imageCount).toBe(1);
    expect(chargeArg.size).toBe("1536x1024");
  });

  it("defaults size to 1024x1024 when the caller omits it", async () => {
    await generateImageFor({
      model: FAKE_MODEL,
      prompt: "a bull",
      telemetry: TELEMETRY,
    });

    expect(mocks.imageProviderCostUsdMicros).toHaveBeenCalledWith(
      "bfl/flux-2-max",
      1,
      "1024x1024",
    );
    const chargeArg = mocks.chargeImageCredits.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(chargeArg.size).toBe("1024x1024");
  });

  // ── Tenant-scope regression (Inngest billing leak) ─────────────────────────
  // chargeImageCredits → consumeCredits → withTenantDb → requireScope. Old code
  // charged scopeless when generateImageFor ran inside an Inngest function (no
  // ambient scope) → TenantScopeError → swallowed → free image. The helper must
  // establish the scope from telemetry around the charge. These mocks call the
  // real requireScope() gate so they FAIL on the old code and PASS on new.
  it("charges inside a tenant scope when none is ambient (Inngest path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeImageCredits.mockImplementation(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 80_000,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
      };
    });

    await generateImageFor({
      model: FAKE_MODEL,
      prompt: "inngest image",
      telemetry: TELEMETRY,
    });

    expect(mocks.chargeImageCredits).toHaveBeenCalledTimes(1);
    expect(chargeSucceeded).toBe(true);
  });

  it("charges successfully when a tenant scope is already active (request path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeImageCredits.mockImplementation(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 80_000,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
      };
    });

    await runInTenantScope(
      { orgId: TELEMETRY.orgId, workspaceId: TELEMETRY.workspaceId },
      async () => {
        await generateImageFor({
          model: FAKE_MODEL,
          prompt: "request image",
          telemetry: TELEMETRY,
        });
      },
    );

    expect(chargeSucceeded).toBe(true);
  });

  it("swallows an insertTokenUsage error and still returns images", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("CH down"));

    const result = await generateImageFor({
      model: FAKE_MODEL,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(result.images).toEqual([FAKE_B64]);
  });

  it("swallows a chargeImageCredits error and still returns images", async () => {
    mocks.chargeImageCredits.mockRejectedValueOnce(new Error("billing down"));

    const result = await generateImageFor({
      model: FAKE_MODEL,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(result.images).toEqual([FAKE_B64]);
  });

  it("propagates errors from generateImage (not swallowed)", async () => {
    mocks.generateImage.mockRejectedValueOnce(new Error("provider error"));

    await expect(
      generateImageFor({
        model: FAKE_MODEL,
        prompt: "fail",
        telemetry: TELEMETRY,
      }),
    ).rejects.toThrow("provider error");
  });
});
