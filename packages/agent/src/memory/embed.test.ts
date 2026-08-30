import { describe, expect, it, vi, beforeEach } from "vitest";

// agent/memory/embed.ts is a thin re-export of @oxagen/ai embedText.
// Mock at the @oxagen/ai seam — do NOT mock the gateway SDK here; the vendor
// SDK is an implementation detail of @oxagen/ai, not of this module.
const mocks = vi.hoisted(() => ({
  embedTextAI: vi.fn(),
}));

mocks.embedTextAI.mockImplementation(async () =>
  new Array(1536).fill(0).map((_, i) => i / 1536),
);

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedTextAI,
}));

import { embedText } from "./embed";

describe("embedText (agent/memory wrapper)", () => {
  beforeEach(() => {
    mocks.embedTextAI.mockClear();
  });

  it("delegates text + telemetry opts to @oxagen/ai embedText and returns its vector", async () => {
    const telemetry = {
      orgId: "org_1",
      workspaceId: "ws_1",
      surface: "runner" as const,
      executionStepId: "req_1",
    };
    const v = await embedText("hello world", { telemetry });
    expect(v).toHaveLength(1536);
    expect(mocks.embedTextAI).toHaveBeenCalledTimes(1);
    const calls = mocks.embedTextAI.mock.calls as unknown[][];
    const [text, opts] = calls[0]!;
    expect(text).toBe("hello world");
    // Telemetry opts are forwarded verbatim — embeddings are always metered
    // now that EmbedTextOpts.telemetry is required.
    expect(opts).toEqual({ telemetry });
  });

  it("forwards telemetry opts to @oxagen/ai embedText", async () => {
    const tel = {
      orgId: "org_1",
      workspaceId: "ws_1",
      surface: "runner" as const,
      executionStepId: "req_1",
    };
    await embedText("test", { telemetry: tel });
    const calls = mocks.embedTextAI.mock.calls as unknown[][];
    const opts = calls[0]![1] as { telemetry?: unknown };
    expect(opts?.telemetry).toEqual(tel);
  });
});
