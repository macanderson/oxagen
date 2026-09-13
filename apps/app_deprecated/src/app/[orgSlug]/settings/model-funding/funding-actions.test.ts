/**
 * funding-actions.test.ts — unit tests for the model-funding server actions
 * (set / verify / delete the org's model-vendor key, and the assistant
 * spend cap).
 *
 * Covers what the actions enforce server-side:
 *   - zod validation (short key, unknown provider, unpaired verify input,
 *     negative or fractional cap) before any DB read
 *   - role re-read from DB (owner/admin only; forbidden otherwise), so a
 *     member never reaches invoke() or the billing write
 *   - the happy paths call invoke() with the right capability name and the
 *     org-only tenant context, and the result never carries the key
 *   - a thrown error becomes a fixed sentence, never the raw message
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database,
 * @oxagen/tenancy, @oxagen/oxagen (invoke), @oxagen/handlers/register,
 * @oxagen/billing, next/cache — the same seams general-action.test.ts and
 * audit.test.ts use. The shared contract schemas stay real: they are pure zod
 * and are what the actions parse the handler's output with.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgMember,
  mockRevalidatePath,
  mockInvoke,
  mockUpdateCap,
  mockRunInTenantScope,
  dbState,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockInvoke: vi.fn(),
  mockUpdateCap: vi.fn(),
  mockRunInTenantScope: vi.fn(),
  dbState: { roleRows: [] as { role: string }[] },
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  assertOrgMember: mockAssertOrgMember,
  getOrgRole: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/billing", () => ({
  updateAssistantSpendCap: mockUpdateCap,
}));
vi.mock("@oxagen/database", () => {
  const tx = {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve(dbState.roleRows),
        }),
      }),
    }),
  };
  return {
    schema: { orgUsers: { role: "role", orgId: "orgId", userId: "userId" } },
    withTenantDb: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
});

import {
  setModelCredentialAction,
  verifyModelCredentialAction,
  deleteModelCredentialAction,
  updateAssistantSpendCapAction,
} from "./funding-actions";

const ORG = { id: "org-1", slug: "acme" };
const NIL_WS = "00000000-0000-0000-0000-000000000000";
const KEY = "sk-or-v1-0123456789abcdef";

const CONFIGURED_VIEW = {
  configured: true,
  provider: "openrouter",
  status: "active",
  keyHint: "cdef",
  lastVerifiedAt: null,
  rotatedAt: "2026-09-09T10:00:00.000Z",
};

const EMPTY_VIEW = {
  configured: false,
  provider: null,
  status: null,
  keyHint: null,
  lastVerifiedAt: null,
  rotatedAt: null,
};

/** Every string in the result, so a leaked key is caught wherever it hides. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringsIn);
  return [];
}

describe("model-funding actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.roleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockRunInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
  });

  describe("setModelCredentialAction", () => {
    it("invokes set_model_credential in the org-only scope and returns the redacted view", async () => {
      mockInvoke.mockResolvedValue(CONFIGURED_VIEW);

      const result = await setModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: KEY,
      });

      expect(result).toEqual({ ok: true, view: CONFIGURED_VIEW });
      expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
      expect(mockRunInTenantScope).toHaveBeenCalledWith(
        { orgId: "org-1", workspaceId: NIL_WS },
        expect.any(Function),
      );
      expect(mockInvoke).toHaveBeenCalledOnce();
      const [name, input, ctx, opts] = mockInvoke.mock.calls[0]!;
      expect(name).toBe("set_model_credential");
      expect(input).toEqual({ provider: "openrouter", apiKey: KEY });
      expect(ctx).toMatchObject({
        orgId: "org-1",
        workspaceId: NIL_WS,
        userId: "user-1",
        surface: "app",
      });
      expect(opts).toEqual({ surface: "api" });
      expect(mockRevalidatePath).toHaveBeenCalledWith(
        "/acme/settings/model-funding",
      );
    });

    it("never includes the key in the result", async () => {
      mockInvoke.mockResolvedValue(CONFIGURED_VIEW);
      const result = await setModelCredentialAction("acme", {
        provider: "gateway",
        apiKey: KEY,
      });
      expect(stringsIn(result).some((s) => s.includes(KEY))).toBe(false);
    });

    it("returns Forbidden for a member and never invokes", async () => {
      dbState.roleRows = [{ role: "member" }];
      const result = await setModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: KEY,
      });
      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("returns Forbidden when no membership row is found", async () => {
      dbState.roleRows = [];
      const result = await setModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: KEY,
      });
      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("rejects a short key before any session or DB read", async () => {
      const result = await setModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: "short",
      });
      expect(result).toEqual({ ok: false, error: "Enter the full API key." });
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("rejects an unknown provider", async () => {
      const result = await setModelCredentialAction("acme", {
        provider: "anthropic",
        apiKey: KEY,
      });
      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("maps a thrown error to a fixed sentence that does not carry the raw message or the key", async () => {
      mockInvoke.mockRejectedValue(new Error(`vendor said no to ${KEY}`));
      const result = await setModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: KEY,
      });
      expect(result).toEqual({
        ok: false,
        error: "Saving the key failed. Test it first, then try again.",
      });
      expect(stringsIn(result).some((s) => s.includes(KEY))).toBe(false);
    });
  });

  describe("verifyModelCredentialAction", () => {
    it("verifies a candidate key through verify_model_credential and reports the vendor's answer", async () => {
      const verification = {
        ok: false,
        provider: "openrouter",
        latencyMs: 210,
        error: "Invalid API key",
      };
      mockInvoke.mockResolvedValue(verification);

      const result = await verifyModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: KEY,
      });

      expect(result).toEqual({ ok: true, verification });
      const [name, input, , opts] = mockInvoke.mock.calls[0]!;
      expect(name).toBe("verify_model_credential");
      expect(input).toEqual({ provider: "openrouter", apiKey: KEY });
      expect(opts).toEqual({ surface: "api" });
      // A test is read-only: nothing to revalidate.
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("verifies the stored key when called with no input", async () => {
      mockInvoke.mockResolvedValue({
        ok: true,
        provider: "gateway",
        latencyMs: 90,
        error: null,
      });
      const result = await verifyModelCredentialAction("acme");
      expect(result.ok).toBe(true);
      expect(mockInvoke.mock.calls[0]![1]).toEqual({});
    });

    it("rejects a provider without a key before any DB read", async () => {
      const result = await verifyModelCredentialAction("acme", {
        provider: "openrouter",
      });
      expect(result).toEqual({ ok: false, error: "Enter a key to test it." });
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("returns Forbidden for a member and never invokes", async () => {
      dbState.roleRows = [{ role: "viewer" }];
      const result = await verifyModelCredentialAction("acme", {
        provider: "openrouter",
        apiKey: KEY,
      });
      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("deleteModelCredentialAction", () => {
    it("invokes delete_model_credential and returns the empty view", async () => {
      mockInvoke.mockResolvedValue(EMPTY_VIEW);
      const result = await deleteModelCredentialAction("acme");
      expect(result).toEqual({ ok: true, view: EMPTY_VIEW });
      const [name, input, ctx, opts] = mockInvoke.mock.calls[0]!;
      expect(name).toBe("delete_model_credential");
      expect(input).toEqual({});
      expect(ctx).toMatchObject({ orgId: "org-1", userId: "user-1" });
      expect(opts).toEqual({ surface: "api" });
      expect(mockRevalidatePath).toHaveBeenCalledWith(
        "/acme/settings/model-funding",
      );
    });

    it("returns Forbidden for a member and never invokes", async () => {
      dbState.roleRows = [{ role: "member" }];
      const result = await deleteModelCredentialAction("acme");
      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("maps a thrown error to a fixed sentence", async () => {
      mockInvoke.mockRejectedValue(new Error("boom"));
      const result = await deleteModelCredentialAction("acme");
      expect(result).toEqual({
        ok: false,
        error: "Removing the key failed. Try again in a moment.",
      });
    });
  });

  describe("updateAssistantSpendCapAction", () => {
    it("writes the cap through updateAssistantSpendCap and revalidates", async () => {
      mockUpdateCap.mockResolvedValue({ assistantSpendCapCents: 2500 });
      const result = await updateAssistantSpendCapAction("acme", 2500);
      expect(result).toEqual({ ok: true, capCents: 2500 });
      expect(mockUpdateCap).toHaveBeenCalledWith("org-1", 2500);
      expect(mockRevalidatePath).toHaveBeenCalledWith(
        "/acme/settings/model-funding",
      );
    });

    it("removes the cap with null", async () => {
      mockUpdateCap.mockResolvedValue({ assistantSpendCapCents: null });
      const result = await updateAssistantSpendCapAction("acme", null);
      expect(result).toEqual({ ok: true, capCents: null });
      expect(mockUpdateCap).toHaveBeenCalledWith("org-1", null);
    });

    it("rejects a negative cap before any session or DB read", async () => {
      const result = await updateAssistantSpendCapAction("acme", -1);
      expect(result).toEqual({
        ok: false,
        error: "The cap cannot be negative.",
      });
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockUpdateCap).not.toHaveBeenCalled();
    });

    it("rejects a fractional cap", async () => {
      const result = await updateAssistantSpendCapAction("acme", 12.5);
      expect(result.ok).toBe(false);
      expect(mockUpdateCap).not.toHaveBeenCalled();
    });

    it("returns Forbidden for a member and never writes", async () => {
      dbState.roleRows = [{ role: "member" }];
      const result = await updateAssistantSpendCapAction("acme", 1000);
      expect(result.ok).toBe(false);
      expect(mockUpdateCap).not.toHaveBeenCalled();
    });

    it("maps a thrown billing error to a fixed sentence", async () => {
      mockUpdateCap.mockRejectedValue(new Error("db down"));
      const result = await updateAssistantSpendCapAction("acme", 1000);
      expect(result).toEqual({
        ok: false,
        error: "Saving the cap failed. Try again in a moment.",
      });
    });
  });
});
