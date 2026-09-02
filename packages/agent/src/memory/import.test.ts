import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so the mock fn exists when the vi.mock factory runs.
const mocks = vi.hoisted(() => ({
  generateObjectForMock: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectForMock,
}));

import { extractMemoriesFromDocument, mapWithConcurrency } from "./import";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [30, 10, 20, 5];
    // Resolve after a delay proportional to the value so completion order
    // differs from input order; the result array must still be input-ordered.
    const out = await mapWithConcurrency(items, 4, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([60, 20, 40, 10]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("invokes fn with the correct index", async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(["a", "b", "c"], 2, async (item, index) => {
      seen.push([item, index]);
      return index;
    });
    expect(seen.sort((x, y) => x[1] - y[1])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("handles an empty input array", async () => {
    const out = await mapWithConcurrency([], 4, async () => 1);
    expect(out).toEqual([]);
  });

  it("clamps worker count to the item count for tiny inputs", async () => {
    // A single item with limit 10 must not spawn 10 idle workers / hang.
    const out = await mapWithConcurrency([42], 10, async (n) => n + 1);
    expect(out).toEqual([43]);
  });
});

// ---------------------------------------------------------------------------
// extractMemoriesFromDocument
// ---------------------------------------------------------------------------

describe("extractMemoriesFromDocument", () => {
  beforeEach(() => {
    mocks.generateObjectForMock.mockReset();
  });

  it("returns the model's extracted, two-axis classified memories", async () => {
    const memories = [
      {
        lesson: "Never push to main.",
        memoryClass: "RULE" as const,
        memoryKind: "constraint",
        enforcementScore: 95,
      },
      {
        lesson: "Run pnpm i after a dep change.",
        memoryClass: "OBSERVATION" as const,
        memoryKind: "routine-change",
      },
    ];
    mocks.generateObjectForMock.mockResolvedValue({ object: { memories } });

    const out = await extractMemoriesFromDocument({
      content: "# Rules\n- never push to main\n- run pnpm i",
      filename: "rules.md",
      ctx: CTX,
    });
    expect(out).toEqual(memories);
  });

  it("leads the prompt with the filename and threads telemetry from ctx", async () => {
    mocks.generateObjectForMock.mockResolvedValue({ object: { memories: [] } });
    await extractMemoriesFromDocument({
      content: "body text",
      filename: "playbook.md",
      ctx: CTX,
    });
    expect(mocks.generateObjectForMock).toHaveBeenCalledTimes(1);
    const arg = mocks.generateObjectForMock.mock.calls[0]?.[0] as {
      prompt: string;
      telemetry: { orgId: string; workspaceId: string };
    };
    expect(arg.prompt.startsWith("Filename: playbook.md")).toBe(true);
    expect(arg.prompt).toContain("body text");
    expect(arg.telemetry.orgId).toBe(CTX.orgId);
    expect(arg.telemetry.workspaceId).toBe(CTX.workspaceId);
  });

  it("returns an empty array when the document yields no memories", async () => {
    mocks.generateObjectForMock.mockResolvedValue({ object: { memories: [] } });
    const out = await extractMemoriesFromDocument({
      content: "Just narrative prose with no rules.",
      filename: "intro.md",
      ctx: CTX,
    });
    expect(out).toEqual([]);
  });

  it("propagates errors from the gateway (parse handler catches per-document)", async () => {
    mocks.generateObjectForMock.mockRejectedValue(new Error("gateway down"));
    await expect(
      extractMemoriesFromDocument({
        content: "x",
        filename: "f.md",
        ctx: CTX,
      }),
    ).rejects.toThrow("gateway down");
  });
});
