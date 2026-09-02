import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  findFirst: vi.fn(),
}));

// Default: insert succeeds and returns a row.
const DEFAULT_ROW = {
  publicId: "invi_TEST001",
  status: "pending",
  expiresAt: new Date("2024-07-15T00:00:00.000Z"),
};

mocks.insertReturning.mockResolvedValue([DEFAULT_ROW]);
mocks.findFirst.mockResolvedValue(null);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: mocks.insertReturning,
            }),
          }),
        }),
        query: {
          invitations: { findFirst: mocks.findFirst },
        },
      }),
  };
});

import { workspaceInviteSendHandler } from "./workspace.invite.send";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspaceInviteSendHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertReturning.mockResolvedValue([DEFAULT_ROW]);
    mocks.findFirst.mockResolvedValue(null);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      workspaceInviteSendHandler(
        { email: "alice@example.com", role: "member" },
        anonCtx,
      ),
    ).rejects.toThrow("workspace.invite.send requires an authenticated user");
  });

  // ── happy path: new invite ────────────────────────────────────────────────

  it("returns id, status, and expires_at for a new invitation", async () => {
    const result = await workspaceInviteSendHandler(
      { email: "alice@example.com", role: "member" },
      CTX,
    );
    expect(result.id).toBe("invi_TEST001");
    expect(result.status).toBe("pending");
    expect(result.expires_at).toBe("2024-07-15T00:00:00.000Z");
  });

  it("calls insert once for a new invite", async () => {
    await workspaceInviteSendHandler(
      { email: "alice@example.com", role: "admin" },
      CTX,
    );
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
  });

  // ── conflict: existing pending invite ────────────────────────────────────

  it("falls back to existing pending invite on insert conflict (no rows returned)", async () => {
    // Simulate onConflictDoNothing returning no rows (duplicate pending exists)
    mocks.insertReturning.mockResolvedValueOnce([]);
    mocks.findFirst.mockResolvedValueOnce({
      publicId: "invi_EXISTING",
      status: "pending",
      expiresAt: new Date("2024-08-01T00:00:00.000Z"),
    });

    const result = await workspaceInviteSendHandler(
      { email: "alice@example.com", role: "member" },
      CTX,
    );

    expect(result.id).toBe("invi_EXISTING");
    expect(result.status).toBe("pending");
    expect(result.expires_at).toBe("2024-08-01T00:00:00.000Z");
  });

  it("throws when conflict + existing row lookup also returns nothing", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    mocks.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      workspaceInviteSendHandler(
        { email: "alice@example.com", role: "member" },
        CTX,
      ),
    ).rejects.toThrow(
      "conflict on insert but no existing pending invite found",
    );
  });

  // ── expires_at fallback ───────────────────────────────────────────────────

  it("falls back to computed expiresAt when row.expiresAt is null", async () => {
    mocks.insertReturning.mockResolvedValueOnce([
      { publicId: "invi_NOEXPIRY", status: "pending", expiresAt: null },
    ]);
    const before = Date.now();
    const result = await workspaceInviteSendHandler(
      { email: "bob@example.com", role: "owner" },
      CTX,
    );
    const resultTime = new Date(result.expires_at).getTime();
    // Should be roughly 7 days from now
    expect(resultTime).toBeGreaterThan(before + 6 * 864e5);
    expect(resultTime).toBeLessThan(before + 8 * 864e5);
  });
});
