/**
 * load-config.test.ts — unit tests for loadWorkspacePromptConfigSafe.
 *
 * Pins the failure-path contract: when the underlying prompt-config read
 * rejects (RLS/DB error), the safe wrapper logs the failure once via the
 * ai.prompts logger and degrades to an empty config ({}) — it never throws and
 * never silently swallows the error. On success it passes the config through
 * unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: { workspaces: { id: "id" } },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

// Stub pino so the degrade warning is observable.
vi.mock("pino", () => ({
  default: vi.fn(() => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn() })),
}));

import { loadWorkspacePromptConfigSafe } from "./load-config";

describe("loadWorkspacePromptConfigSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs once and returns {} when the inner read rejects", async () => {
    mocks.withTenantDb.mockRejectedValueOnce(
      new Error("RLS: permission denied"),
    );

    const result = await loadWorkspacePromptConfigSafe("ws-uuid-1");

    expect(result).toEqual({});
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = mocks.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta).toMatchObject({ workspaceId: "ws-uuid-1" });
    expect(meta.err).toBeInstanceOf(Error);
    expect(msg).toMatch(/prompt-config read failed/i);
  });

  it("passes the normalized config through on success without logging", async () => {
    mocks.withTenantDb.mockResolvedValueOnce({
      promptConfig: {
        additionalInstructions: "Always cite sources.",
        autoImprovePrompts: false,
      },
    });

    const result = await loadWorkspacePromptConfigSafe("ws-uuid-2");

    expect(result).toMatchObject({
      additionalInstructions: "Always cite sources.",
      autoImprovePrompts: false,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("returns {} without a DB read (and without logging) for a null workspaceId", async () => {
    const result = await loadWorkspacePromptConfigSafe(null);

    expect(result).toEqual({});
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
