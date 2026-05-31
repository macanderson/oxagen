import { describe, expect, it, vi, beforeEach } from "vitest";

// OXA-1425: agent/memory/embed.ts is a thin re-export of @oxagen/ai embedText.
// Mock at the @oxagen/ai seam — do NOT mock @ai-sdk/openai here; the vendor
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

import { embedText } from "./embed.js";

describe("embedText (agent/memory wrapper)", () => {
  beforeEach(() => {
    mocks.embedTextAI.mockClear();
  });

  it("delegates to @oxagen/ai embedText and returns its vector", async () => {
    const v = await embedText("hello world");
    expect(v).toHaveLength(1536);
    expect(mocks.embedTextAI).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const calls: unknown[][] = (mocks.embedTextAI.mock.calls as any);
    const [text, opts] = calls[0]!;
    expect(text).toBe("hello world");
    // Default call passes empty opts object.
    expect(opts).toEqual({});
  });

  it("forwards telemetry opts to @oxagen/ai embedText", async () => {
    const tel = {
      orgId: "org_1",
      workspaceId: "ws_1",
      surface: "runner" as const,
      executionStepId: "req_1",
    };
    await embedText("test", { telemetry: tel });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const calls: unknown[][] = (mocks.embedTextAI.mock.calls as any);
    const opts = calls[0]![1] as { telemetry?: unknown };
    expect(opts?.telemetry).toEqual(tel);
  });
});
