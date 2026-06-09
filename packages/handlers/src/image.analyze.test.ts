import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  selectModel: mocks.selectModel,
  // Prompt-registry wiring (the analysis instruction now resolves through the
  // registry so workspace overrides/append apply). Passthrough in tests.
  loadWorkspacePromptConfig: vi.fn(async () => ({})),
  resolvePrompt: (a: { baseline: string }) => a.baseline,
  imageAnalyzePrompt: () => "analyze baseline",
}));

// Build a fake select chain for the asset lookup
function makeSelectBuilder(rows: unknown[]): unknown {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

<<<<<<< HEAD
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withSystemDb: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
    fn({ select: mocks.dbSelect } as unknown as Record<string, unknown>),

  };
});
=======
vi.mock("@oxagen/database", () => ({
  withSystemDb: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
    fn({ select: mocks.dbSelect } as unknown as Record<string, unknown>),
  schema: {
    generatedAssets: {
      publicId: "ga.publicId",
      workspaceId: "ga.workspaceId",
      status: "ga.status",
      deletedAt: "ga.deletedAt",
      storageUrl: "ga.storageUrl",
      mimeType: "ga.mimeType",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ $type: "eq", col, val }),
  and: (...args: unknown[]) => ({ $type: "and", args }),
  isNull: (col: unknown) => ({ $type: "isNull", col }),
}));
>>>>>>> feat/hardening-cost-prompts-motion-rebrand

// ── import under test ─────────────────────────────────────────────────────────

import { imageAnalyzeHandler } from "./image.analyze";
<<<<<<< HEAD

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";
=======
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: "msg_1",
};
>>>>>>> feat/hardening-cost-prompts-motion-rebrand

const FAKE_MODEL = { modelId: "anthropic/claude-sonnet-4.6" };

const FAKE_ASSET = {
  storageUrl: "https://blob.store/gen_abc.png",
  mimeType: "image/png",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("imageAnalyzeHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectModel.mockReturnValue(FAKE_MODEL);
    mocks.dbSelect.mockReturnValue(makeSelectBuilder([FAKE_ASSET]));
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        analysis: "The image shows a serene coastal landscape.",
        tags: ["ocean", "sunset", "coastal", "landscape"],
        description: "A wide-angle photograph of a sunset over the ocean.",
      },
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    });
  });

  it("returns analysis, tags, and description on success", async () => {
    const result = await imageAnalyzeHandler({ image_id: "gen_abc" }, CTX);

    expect(result.analysis).toBe("The image shows a serene coastal landscape.");
    expect(result.tags).toEqual(["ocean", "sunset", "coastal", "landscape"]);
    expect(result.description).toBe("A wide-angle photograph of a sunset over the ocean.");
  });

  it("passes the image URL as a multimodal message to generateObjectFor", async () => {
    await imageAnalyzeHandler({ image_id: "gen_abc" }, CTX);

    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: Array<{ type: string; image?: string }> }>;
    };
    const imageContent = call.messages[0]?.content.find((c) => c.type === "image");
    expect(imageContent?.image).toBe("https://blob.store/gen_abc.png");
  });

  it("forwards telemetry context to generateObjectFor", async () => {
<<<<<<< HEAD
    await imageAnalyzeHandler({ image_id: "gen_abc" }, { ...CTX, messageId: "msg_1" });
=======
    await imageAnalyzeHandler({ image_id: "gen_abc" }, CTX);
>>>>>>> feat/hardening-cost-prompts-motion-rebrand

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: Record<string, unknown>;
    };
    expect(call.telemetry.orgId).toBe("org_1");
    expect(call.telemetry.workspaceId).toBe("ws_1");
    expect(call.telemetry.messageId).toBe("msg_1");
    expect(call.telemetry.surface).toBe("api");
  });

  it("falls back to requestId for telemetry when messageId is null", async () => {
    await imageAnalyzeHandler({ image_id: "gen_abc" }, { ...CTX, messageId: null });

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: Record<string, unknown>;
    };
    expect(call.telemetry.messageId).toBe("req_1");
  });

  it("throws when asset is not found", async () => {
    mocks.dbSelect.mockReturnValue(makeSelectBuilder([]));

    await expect(imageAnalyzeHandler({ image_id: "gen_missing" }, CTX)).rejects.toThrow(
      /not found or not ready/i,
    );
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("throws when asset has no storageUrl (pending/failed)", async () => {
    mocks.dbSelect.mockReturnValue(makeSelectBuilder([{ storageUrl: null, mimeType: "image/png" }]));

    await expect(imageAnalyzeHandler({ image_id: "gen_pending" }, CTX)).rejects.toThrow(
      /not found or not ready/i,
    );
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });
});
