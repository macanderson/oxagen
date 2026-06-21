import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  installOne: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("./plugin.org.install", () => ({
  installOne: mocks.installOne,
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

import { handler } from "./plugin.org.install_bulk";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null as string | null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null as string | null,
};

const ITEM_A = { pluginType: "capability" as const, pluginId: "cap-a", catalogServerId: undefined };
const ITEM_B = { pluginType: "mcp_server" as const, pluginId: "mcp-b", catalogServerId: undefined };

// ─────────────────────────────────────────────────────────────────────────────

describe("plugin.org.install_bulk handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns all items as successful when every installOne succeeds", async () => {
    mocks.installOne.mockResolvedValueOnce("listing-a").mockResolvedValueOnce("listing-b");

    const result = await handler({ items: [ITEM_A, ITEM_B] }, ctx) as {
      installed: Array<{ pluginId: string | null; orgListingId: string | null; error: string | null }>;
    };

    expect(result.installed).toHaveLength(2);
    expect(result.installed[0]).toEqual({ pluginId: "cap-a", orgListingId: "listing-a", error: null });
    expect(result.installed[1]).toEqual({ pluginId: "mcp-b", orgListingId: "listing-b", error: null });
  });

  it("emits a security event for each successfully installed item", async () => {
    mocks.installOne.mockResolvedValueOnce("listing-a").mockResolvedValueOnce("listing-b");

    await handler({ items: [ITEM_A, ITEM_B] }, ctx);

    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(2);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.installed",
        orgId: "org-1",
        outcome: "success",
      }),
    );
  });

  // ── partial failure (the core design) ────────────────────────────────────
  // The handler intentionally captures per-item failures in the installed[]
  // array rather than throwing, so callers can distinguish which items failed.
  // This test verifies the error is embedded (not thrown) AND that the failure
  // does not prevent the successful item from completing.

  it("captures per-item failures in installed[].error without throwing", async () => {
    mocks.installOne
      .mockResolvedValueOnce("listing-a")
      .mockRejectedValueOnce(new Error("plugin not found in catalog"));

    const result = await handler({ items: [ITEM_A, ITEM_B] }, ctx) as {
      installed: Array<{ pluginId: string | null; orgListingId: string | null; error: string | null }>;
    };

    expect(result.installed).toHaveLength(2);

    // Successful item
    expect(result.installed[0]).toEqual({ pluginId: "cap-a", orgListingId: "listing-a", error: null });

    // Failed item: error string embedded, orgListingId is null
    expect(result.installed[1]).toEqual({
      pluginId: "mcp-b",
      orgListingId: null,
      error: "plugin not found in catalog",
    });
  });

  it("captures all-items-failed without throwing — caller must inspect the array", async () => {
    mocks.installOne
      .mockRejectedValueOnce(new Error("DB timeout"))
      .mockRejectedValueOnce(new Error("auth denied"));

    const result = await handler({ items: [ITEM_A, ITEM_B] }, ctx) as {
      installed: Array<{ pluginId: string | null; orgListingId: string | null; error: string | null }>;
    };

    expect(result.installed).toHaveLength(2);
    expect(result.installed.every((r) => r.error !== null)).toBe(true);
    expect(result.installed[0]?.error).toBe("DB timeout");
    expect(result.installed[1]?.error).toBe("auth denied");
  });

  it("does not emit a security event for failed items", async () => {
    mocks.installOne.mockRejectedValueOnce(new Error("install failed"));

    await handler({ items: [ITEM_A] }, ctx);

    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("handles a single item successfully", async () => {
    mocks.installOne.mockResolvedValueOnce("listing-solo");

    const result = await handler({ items: [ITEM_A] }, ctx) as {
      installed: Array<{ pluginId: string | null; orgListingId: string | null; error: string | null }>;
    };

    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]).toEqual({ pluginId: "cap-a", orgListingId: "listing-solo", error: null });
  });

  it("stores non-Error rejection as a string in the error field", async () => {
    mocks.installOne.mockRejectedValueOnce("raw string rejection");

    const result = await handler({ items: [ITEM_A] }, ctx) as {
      installed: Array<{ pluginId: string | null; orgListingId: string | null; error: string | null }>;
    };

    expect(result.installed[0]?.error).toBe("raw string rejection");
  });
});
