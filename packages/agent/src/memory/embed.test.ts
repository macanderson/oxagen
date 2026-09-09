import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedTextAIMock, embedManyAIMock } = vi.hoisted(() => ({
  embedTextAIMock: vi.fn(),
  embedManyAIMock: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  embedText: embedTextAIMock,
  embedMany: embedManyAIMock,
}));

import { embedMany, embedText } from "./embed";

const OPTS = {
  telemetry: { orgId: "org_1", workspaceId: "ws_1", surface: "runner" },
} as Parameters<typeof embedText>[1];

beforeEach(() => {
  embedTextAIMock.mockReset();
  embedManyAIMock.mockReset();
});

describe("memory embedding wrappers", () => {
  it("embedText delegates to the metered @oxagen/ai wrapper", async () => {
    embedTextAIMock.mockResolvedValueOnce([0.1, 0.2]);
    await expect(embedText("hello", OPTS)).resolves.toEqual([0.1, 0.2]);
    expect(embedTextAIMock).toHaveBeenCalledWith("hello", OPTS);
  });

  it("embedMany batches through the metered @oxagen/ai wrapper in one call", async () => {
    embedManyAIMock.mockResolvedValueOnce([[0.1], [0.2]]);
    await expect(embedMany(["a", "b"], OPTS)).resolves.toEqual([[0.1], [0.2]]);
    expect(embedManyAIMock).toHaveBeenCalledTimes(1);
    expect(embedManyAIMock).toHaveBeenCalledWith(["a", "b"], OPTS);
  });
});
