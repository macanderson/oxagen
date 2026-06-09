/**
 * prompt.settings.write handler tests.
 * Strategy: mock @oxagen/database (read-merge-write) + @oxagen/billing (tier gate).
 * Assert: no workspace → throws; additionalInstructions/autoImprove writable on any
 * tier; overrides require enterprise (requireTier gate); partial-merge semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  set: vi.fn((_value: unknown) => ({ where: vi.fn().mockResolvedValue(undefined) })),
  resolveOrgTier: vi.fn(),
  requireTier: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: { workspaces: { findFirst: mocks.findFirst } },
      update: () => ({ set: mocks.set }),
    }),

  };
});

vi.mock("@oxagen/billing", () => ({
  resolveOrgTier: mocks.resolveOrgTier,
  requireTier: mocks.requireTier,
}));

import { promptSettingsWriteHandler } from "./prompt.settings.write";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

beforeEach(() => {
  mocks.findFirst.mockReset().mockResolvedValue({ settings: {} });
  mocks.set.mockClear();
  mocks.resolveOrgTier.mockReset().mockResolvedValue("build");
  mocks.requireTier.mockReset();
});

describe("promptSettingsWriteHandler", () => {
  it("throws without a workspace context", async () => {
    await expect(
      promptSettingsWriteHandler({}, { ...CTX, workspaceId: null as unknown as string }),
    ).rejects.toThrow(/workspace context/);
  });

  it("writes additionalInstructions + autoImprovePrompts on any tier (no tier check)", async () => {
    const out = await promptSettingsWriteHandler(
      { additionalInstructions: "Be formal.", autoImprovePrompts: false },
      CTX,
    );
    expect(mocks.resolveOrgTier).not.toHaveBeenCalled();
    expect(mocks.requireTier).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(out.additionalInstructions).toBe("Be formal.");
    expect(out.autoImprovePrompts).toBe(false);
  });

  it("enforces the enterprise tier gate when overrides are provided", async () => {
    mocks.resolveOrgTier.mockResolvedValue("enterprise");
    await promptSettingsWriteHandler(
      { overrides: { "svg.generate": "Brand voice." } },
      CTX,
    );
    expect(mocks.resolveOrgTier).toHaveBeenCalledWith("org_1");
    expect(mocks.requireTier).toHaveBeenCalledWith("enterprise", "enterprise", "prompt-overrides");
  });

  it("rejects overrides below enterprise (requireTier throws)", async () => {
    mocks.resolveOrgTier.mockResolvedValue("build");
    mocks.requireTier.mockImplementation(() => {
      throw new Error("tier denied");
    });
    await expect(
      promptSettingsWriteHandler({ overrides: { "image.analyze": "x" } }, CTX),
    ).rejects.toThrow(/tier denied/);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("merges into existing promptConfig, preserving other settings keys", async () => {
    mocks.findFirst.mockResolvedValue({
      settings: { theme: "dark", promptConfig: { additionalInstructions: "old", autoImprovePrompts: true } },
    });
    await promptSettingsWriteHandler({ additionalInstructions: "new" }, CTX);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const written = mocks.set.mock.calls[0]![0] as { settings: Record<string, unknown> };
    expect(written.settings.theme).toBe("dark");
    const pc = written.settings.promptConfig as Record<string, unknown>;
    expect(pc.additionalInstructions).toBe("new");
    expect(pc.autoImprovePrompts).toBe(true); // preserved
  });
});
