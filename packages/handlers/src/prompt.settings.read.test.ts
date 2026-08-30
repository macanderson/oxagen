/**
 * prompt.settings.read handler tests.
 * Strategy: mock @oxagen/ai's loadWorkspacePromptConfig (the DB read + normalize).
 * Assert: no workspace → throws; output shape; autoImprovePrompts defaults to ON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({ loadWorkspacePromptConfig: vi.fn() }));

vi.mock("@oxagen/ai", () => ({
  loadWorkspacePromptConfig: mocks.loadWorkspacePromptConfig,
}));

import { promptSettingsReadHandler } from "./prompt.settings.read";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

beforeEach(() => mocks.loadWorkspacePromptConfig.mockReset());

describe("promptSettingsReadHandler", () => {
  it("throws without a workspace context", async () => {
    await expect(
      promptSettingsReadHandler(
        {},
        { ...CTX, workspaceId: null as unknown as string },
      ),
    ).rejects.toThrow(/workspace context/);
  });

  it("returns stored config", async () => {
    mocks.loadWorkspacePromptConfig.mockResolvedValue({
      additionalInstructions: "Be terse.",
      overrides: { "svg.generate": "Flat design." },
      autoImprovePrompts: false,
    });
    const out = await promptSettingsReadHandler({}, CTX);
    expect(out).toEqual({
      additionalInstructions: "Be terse.",
      overrides: { "svg.generate": "Flat design." },
      autoImprovePrompts: false,
    });
  });

  it("defaults autoImprovePrompts to ON and overrides to {} when unset", async () => {
    mocks.loadWorkspacePromptConfig.mockResolvedValue({});
    const out = await promptSettingsReadHandler({}, CTX);
    expect(out.additionalInstructions).toBeNull();
    expect(out.overrides).toEqual({});
    expect(out.autoImprovePrompts).toBe(true);
  });
});
