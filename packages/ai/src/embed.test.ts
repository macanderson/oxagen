import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock at the vendor-SDK + telemetry seam — embedText must not expose
// @ai-sdk/openai or ClickHouse internals to callers (OXA-1425).
const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embeddingModel: vi.fn(),
  createOpenAI: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
}));

// Stub the AI SDK embed call.
mocks.embed.mockImplementation(async () => ({
  embedding: new Array(1536).fill(0).map((_, i) => i / 1536),
  usage: { tokens: 7 },
}));
mocks.embeddingModel.mockReturnValue({ modelId: "text-embedding-3-small" });
mocks.createOpenAI.mockReturnValue({ embedding: mocks.embeddingModel });
// Telemetry stubs.
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("deadbeefdeadbeef");

vi.mock("ai", () => ({ embed: mocks.embed }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
}));
vi.mock("@oxagen/telemetry", () => ({
  insertTokenUsage: mocks.insertTokenUsage,
  hashPrompt: mocks.hashPrompt,
  providerFromModelId: (id: string) => {
    const head = id.split(":")[0] ?? "";
    return head === "openai" ? "openai" : "";
  },
}));

import { embedText } from "./embed.js";

describe("embedText (@oxagen/ai)", () => {
  beforeEach(() => {
    mocks.embed.mockClear();
    mocks.insertTokenUsage.mockClear();
    mocks.hashPrompt.mockClear();
  });

  it("calls the OpenAI embedding model with the correct model id and returns a 1536-d vector", async () => {
    const v = await embedText("hello");
    expect(v).toHaveLength(1536);
    expect(mocks.embeddingModel).toHaveBeenCalledWith("text-embedding-3-small");
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const args = mocks.embed.mock.calls[0]?.[0] as { value: string };
    expect(args.value).toBe("hello");
  });

  it("does NOT write a token_usage row when telemetry opts are omitted", async () => {
    await embedText("no-telemetry");
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
  });

  it("writes exactly ONE token_usage row when telemetry opts are provided", async () => {
    await embedText("meter me", {
      telemetry: {
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "runner",
        executionStepId: "req_abc",
      },
    });
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const firstCall = mocks.insertTokenUsage.mock.calls[0] as [unknown[], ...unknown[]];
    const rows: unknown[] = firstCall[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("org_1");
    expect(row.workspace_id).toBe("ws_1");
    expect(row.surface).toBe("runner");
    expect(row.execution_step_id).toBe("req_abc");
    expect(row.model).toBe("text-embedding-3-small");
    expect(row.provider).toBe("openai");
    expect(row.input_tokens).toBe(7);
    expect(row.output_tokens).toBe(0);
  });

  it("swallows telemetry errors and still returns the embedding", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("clickhouse down"));
    const v = await embedText("resilient", {
      telemetry: {
        orgId: "org_2",
        workspaceId: "ws_2",
        surface: "api",
        executionStepId: "req_xyz",
      },
    });
    // Embedding must succeed even when ClickHouse is unreachable.
    expect(v).toHaveLength(1536);
  });
});
