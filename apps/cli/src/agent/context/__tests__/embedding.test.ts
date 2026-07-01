/**
 * GatewayEmbeddingClient tests. The AI SDK `embed`/`embedMany` and the gateway
 * provider are mocked so no network call is made; this exercises the client's
 * default (non-injected) code path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
  embeddingModel: vi.fn(),
}));

vi.mock("ai", () => ({
  embed: mocks.embed,
  embedMany: mocks.embedMany,
}));
vi.mock("@ai-sdk/gateway", () => ({
  gateway: { embeddingModel: mocks.embeddingModel },
}));

import { GatewayEmbeddingClient, GATEWAY_PROVIDER_ID } from "../embedding.js";
import { CODE_EMBED_DIM } from "@oxagen/code-graph/embed";

beforeEach(() => {
  mocks.embed.mockReset();
  mocks.embedMany.mockReset();
  mocks.embeddingModel.mockReset();
  mocks.embeddingModel.mockReturnValue({ modelId: GATEWAY_PROVIDER_ID });
});

describe("GatewayEmbeddingClient", () => {
  it("pins the shared model id and dimension", () => {
    const c = new GatewayEmbeddingClient();
    expect(c.providerId).toBe(GATEWAY_PROVIDER_ID);
    expect(c.dimensions).toBe(CODE_EMBED_DIM);
  });

  it("embed() routes through the gateway embedding model", async () => {
    mocks.embed.mockResolvedValue({ embedding: [1, 2, 3] });
    const c = new GatewayEmbeddingClient();
    await expect(c.embed("hello")).resolves.toEqual([1, 2, 3]);
    expect(mocks.embeddingModel).toHaveBeenCalledWith(GATEWAY_PROVIDER_ID);
    expect(mocks.embed).toHaveBeenCalledOnce();
  });

  it("embedBatch() uses embedMany and preserves order", async () => {
    mocks.embedMany.mockResolvedValue({ embeddings: [[1], [2]] });
    const c = new GatewayEmbeddingClient();
    await expect(c.embedBatch(["a", "b"])).resolves.toEqual([[1], [2]]);
    expect(mocks.embedMany).toHaveBeenCalledOnce();
  });

  it("embedBatch([]) short-circuits without a gateway call", async () => {
    const c = new GatewayEmbeddingClient();
    await expect(c.embedBatch([])).resolves.toEqual([]);
    expect(mocks.embedMany).not.toHaveBeenCalled();
  });

  it("honours injected deps (no gateway call)", async () => {
    const c = new GatewayEmbeddingClient({
      embedOne: async () => [9],
      embedMany: async (texts) => texts.map(() => [9]),
    });
    await expect(c.embed("x")).resolves.toEqual([9]);
    await expect(c.embedBatch(["x", "y"])).resolves.toEqual([[9], [9]]);
    expect(mocks.embed).not.toHaveBeenCalled();
  });
});
