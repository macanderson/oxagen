/**
 * security-action.test.ts — unit tests for setPasswordAction, unlinkAccountAction,
 * and the signInMethodCount / last-method-guard logic in fetchConnectedAccountsState.
 *
 * Covers:
 *   (a) fetchConnectedAccountsState — hasPassword and signInMethodCount derivation
 *       across the four meaningful configurations:
 *         1. 2 socials + no pw  → each social removable (count = 2)
 *         2. 1 social + no pw   → not removable (count = 1)
 *         3. 1 social + pw      → both removable (count = 2)
 *         4. 0 social + pw      → password-only, count = 1 (no remove path here,
 *            but verifying count is 1 so a UI guard would apply)
 *   (b) setPasswordAction — happy path, validation errors, already-set error
 *   (c) unlinkAccountAction — happy path, last-method guard, API errors
 *
 * Mock seam: @oxagen/auth (auth.api.*), @/lib/session, next/headers, next/cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports.
// vi.hoisted is required for variables referenced inside vi.mock() factories
// because vi.mock() calls are hoisted to the top of the file by Vitest.
// ---------------------------------------------------------------------------

const { mockListUserAccounts, mockSetPassword, mockUnlinkAccount } = vi.hoisted(
  () => ({
    mockListUserAccounts: vi.fn(),
    mockSetPassword: vi.fn(),
    mockUnlinkAccount: vi.fn(),
  }),
);

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  auth: {
    api: {
      listUserAccounts: mockListUserAccounts,
      setPassword: mockSetPassword,
      unlinkAccount: mockUnlinkAccount,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  fetchConnectedAccountsState,
  setPasswordAction,
  unlinkAccountAction,
} from "./security-action";
import { getSessionOrRedirect } from "@/lib/session";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-123", email: "user@example.com" } };

function makeAccount(
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `acc-${providerId}`,
    providerId,
    accountId: `${providerId}-external-id`,
    userId: "user-123",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    scopes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) fetchConnectedAccountsState — signInMethodCount + hasPassword derivation
// ---------------------------------------------------------------------------

describe("fetchConnectedAccountsState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("2 socials + no pw: count = 2, hasPassword = false, both removable", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);

    const state = await fetchConnectedAccountsState("user-123", new Headers());

    expect(state.hasPassword).toBe(false);
    expect(state.signInMethodCount).toBe(2);
    // Both are removable because count > 1
    expect(state.signInMethodCount > 1).toBe(true);
  });

  it("1 social + no pw: count = 1, hasPassword = false, not removable", async () => {
    mockListUserAccounts.mockResolvedValue([makeAccount("google")]);

    const state = await fetchConnectedAccountsState("user-123", new Headers());

    expect(state.hasPassword).toBe(false);
    expect(state.signInMethodCount).toBe(1);
    // signInMethodCount <= 1 → guard should block removal
    expect(state.signInMethodCount <= 1).toBe(true);
  });

  it("1 social + pw: count = 2, both removable", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("credential"),
    ]);

    const state = await fetchConnectedAccountsState("user-123", new Headers());

    expect(state.hasPassword).toBe(true);
    expect(state.signInMethodCount).toBe(2);
    expect(state.signInMethodCount > 1).toBe(true);
  });

  it("0 social + pw only: count = 1, hasPassword = true", async () => {
    mockListUserAccounts.mockResolvedValue([makeAccount("credential")]);

    const state = await fetchConnectedAccountsState("user-123", new Headers());

    expect(state.hasPassword).toBe(true);
    expect(state.signInMethodCount).toBe(1);
    // Password is the only method; signInMethodCount <= 1 means it cannot be removed
    expect(state.signInMethodCount <= 1).toBe(true);
  });

  it("includes all accounts in the returned accounts array", async () => {
    const accounts = [makeAccount("google"), makeAccount("github")];
    mockListUserAccounts.mockResolvedValue(accounts);

    const state = await fetchConnectedAccountsState("user-123", new Headers());

    expect(state.accounts).toHaveLength(2);
    expect(state.accounts[0]?.providerId).toBe("google");
    expect(state.accounts[1]?.providerId).toBe("github");
  });

  it("handles empty account list: count = 0, hasPassword = false", async () => {
    mockListUserAccounts.mockResolvedValue([]);

    const state = await fetchConnectedAccountsState("user-123", new Headers());

    expect(state.hasPassword).toBe(false);
    expect(state.signInMethodCount).toBe(0);
    expect(state.accounts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) setPasswordAction
// ---------------------------------------------------------------------------

describe("setPasswordAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    // fetchConnectedAccountsState is called during unlinkAccount, not setPassword
    mockListUserAccounts.mockResolvedValue([makeAccount("google")]);
  });

  it("returns ok:true when setPassword succeeds", async () => {
    mockSetPassword.mockResolvedValue({ status: true });

    const result = await setPasswordAction({
      newPassword: "securepass1",
      confirmPassword: "securepass1",
    });

    expect(result.ok).toBe(true);
    expect(mockSetPassword).toHaveBeenCalledOnce();
    expect(mockSetPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { newPassword: "securepass1" },
      }),
    );
  });

  it("returns ok:false when passwords do not match (client-side guard)", async () => {
    const result = await setPasswordAction({
      newPassword: "securepass1",
      confirmPassword: "different",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Passwords do not match",
    );
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("returns ok:false when password is too short (zod validation)", async () => {
    const result = await setPasswordAction({
      newPassword: "short",
      confirmPassword: "short",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /at least 8/i,
    );
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("returns ok:false with friendly message when password already set", async () => {
    mockSetPassword.mockRejectedValue(new Error("PASSWORD_ALREADY_SET"));

    const result = await setPasswordAction({
      newPassword: "newpassword",
      confirmPassword: "newpassword",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /already set/i,
    );
  });

  it("returns ok:false with generic message on unexpected error", async () => {
    mockSetPassword.mockRejectedValue(new Error("Network error"));

    const result = await setPasswordAction({
      newPassword: "validpass123",
      confirmPassword: "validpass123",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /failed to set password/i,
    );
  });
});

// ---------------------------------------------------------------------------
// (c) unlinkAccountAction
// ---------------------------------------------------------------------------

describe("unlinkAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
  });

  it("returns ok:true when unlink succeeds (2 methods available)", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);
    mockUnlinkAccount.mockResolvedValue({ status: true });

    const result = await unlinkAccountAction({ providerId: "google" });

    expect(result.ok).toBe(true);
    expect(mockUnlinkAccount).toHaveBeenCalledOnce();
  });

  it("blocks unlink and returns ok:false when only 1 sign-in method (1 social, no pw)", async () => {
    mockListUserAccounts.mockResolvedValue([makeAccount("google")]);

    const result = await unlinkAccountAction({ providerId: "google" });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /set a password or connect another account/i,
    );
    expect(mockUnlinkAccount).not.toHaveBeenCalled();
  });

  it("allows unlink of social when password also exists (count = 2)", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("credential"),
    ]);
    mockUnlinkAccount.mockResolvedValue({ status: true });

    const result = await unlinkAccountAction({ providerId: "google" });

    expect(result.ok).toBe(true);
    expect(mockUnlinkAccount).toHaveBeenCalledOnce();
  });

  it("passes accountId through to the API when provided", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);
    mockUnlinkAccount.mockResolvedValue({ status: true });

    await unlinkAccountAction({
      providerId: "google",
      accountId: "google-external-id",
    });

    expect(mockUnlinkAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { providerId: "google", accountId: "google-external-id" },
      }),
    );
  });

  it("returns ok:false with friendly message when API throws FAILED_TO_UNLINK_LAST_ACCOUNT", async () => {
    // With 2 accounts the guard passes, but we simulate the server also rejecting.
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);
    mockUnlinkAccount.mockRejectedValue(
      new Error("FAILED_TO_UNLINK_LAST_ACCOUNT"),
    );

    const result = await unlinkAccountAction({ providerId: "google" });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /set a password or connect another account/i,
    );
  });

  it("returns ok:false on generic API error", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);
    mockUnlinkAccount.mockRejectedValue(new Error("Something went wrong"));

    const result = await unlinkAccountAction({ providerId: "google" });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /failed to disconnect/i,
    );
  });

  it("returns ok:false with 'Account not found' on ACCOUNT_NOT_FOUND error", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);
    mockUnlinkAccount.mockRejectedValue(new Error("ACCOUNT_NOT_FOUND"));

    const result = await unlinkAccountAction({ providerId: "google" });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /account not found/i,
    );
  });

  it("returns ok:false validation_error when providerId is empty string", async () => {
    mockListUserAccounts.mockResolvedValue([
      makeAccount("google"),
      makeAccount("github"),
    ]);

    const result = await unlinkAccountAction({ providerId: "" });

    expect(result.ok).toBe(false);
    // Empty providerId fails z.string().min(1) validation before the API call.
    expect(mockUnlinkAccount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Additional setPasswordAction coverage: PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG
// ---------------------------------------------------------------------------

describe("setPasswordAction — additional error branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    mockListUserAccounts.mockResolvedValue([makeAccount("google")]);
  });

  it("returns ok:false with min-length message when API throws PASSWORD_TOO_SHORT", async () => {
    mockSetPassword.mockRejectedValue(new Error("PASSWORD_TOO_SHORT"));

    const result = await setPasswordAction({
      newPassword: "validpass123",
      confirmPassword: "validpass123",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /too short/i,
    );
  });

  it("returns ok:false with max-length message when API throws PASSWORD_TOO_LONG", async () => {
    mockSetPassword.mockRejectedValue(new Error("PASSWORD_TOO_LONG"));

    const result = await setPasswordAction({
      newPassword: "validpass123",
      confirmPassword: "validpass123",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/too long/i);
  });
});
