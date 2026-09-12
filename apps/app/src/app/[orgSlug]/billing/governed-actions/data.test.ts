/**
 * data.test.ts — unit tests for the three page-render reads.
 *
 * Two things are worth holding here:
 *   1. The explicit authorization gate. `apps/app` skips kernel IAM, so
 *      `resolveBillingViewer` asserting BOTH membership and the billing role is
 *      the whole gate on this page.
 *   2. The degrade-not-zero policy. A failed read must return `{ ok: false }`
 *      so the caller renders "unavailable". Returning an empty output shape
 *      would put a fabricated zero on a billing page.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockInvoke,
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgMember,
  mockAssertBillingManager,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockAssertBillingManager: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/session", () => ({ getSession: mockGetSession }));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  assertOrgMember: mockAssertOrgMember,
  assertBillingManager: mockAssertBillingManager,
}));

import {
  loadActionUsage,
  loadEvidenceRetention,
  loadRateCard,
  resolveBillingViewer,
} from "./data";

const VIEWER = { orgId: "org-1", orgSlug: "acme", viewerUserId: "user-1" };

beforeEach(() => {
  mockInvoke.mockReset().mockResolvedValue({ ok: "payload" });
  mockResolveOrg.mockReset().mockResolvedValue({ id: "org-1", slug: "acme" });
  mockGetSession.mockReset().mockResolvedValue({ user: { id: "user-1" } });
  mockAssertOrgMember.mockReset().mockResolvedValue(undefined);
  mockAssertBillingManager.mockReset().mockResolvedValue(undefined);
});

describe("resolveBillingViewer — the gate apps/app does not get for free", () => {
  it("asserts membership AND the billing role before any read", async () => {
    const viewer = await resolveBillingViewer("acme");
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockAssertBillingManager).toHaveBeenCalledWith("org-1", "user-1");
    expect(viewer).toEqual(VIEWER);
  });

  it("propagates the notFound() a non-manager gets, rather than swallowing it", async () => {
    mockAssertBillingManager.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(resolveBillingViewer("acme")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("skips the asserts for an anonymous request (the layout redirects it)", async () => {
    mockGetSession.mockResolvedValue(null);
    const viewer = await resolveBillingViewer("acme");
    expect(mockAssertOrgMember).not.toHaveBeenCalled();
    expect(mockAssertBillingManager).not.toHaveBeenCalled();
    expect(viewer.viewerUserId).toBe("");
  });
});

describe("the three reads — capability names and inputs", () => {
  it("loadRateCard invokes get_rate_card with an empty input", async () => {
    await loadRateCard(VIEWER);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_rate_card",
      {},
      expect.objectContaining({ orgId: "org-1", userId: "user-1" }),
      { surface: "agent" },
    );
  });

  it("loadActionUsage defaults the ClickHouse breakdown off", async () => {
    await loadActionUsage(VIEWER);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_action_usage",
      { includeBreakdown: false },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("loadActionUsage forwards an explicit breakdown request", async () => {
    await loadActionUsage(VIEWER, { includeBreakdown: true });
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_action_usage",
      { includeBreakdown: true },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("loadEvidenceRetention invokes get_evidence_retention", async () => {
    await loadEvidenceRetention(VIEWER);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_evidence_retention",
      {},
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("scopes every read to the org with the org-only workspace sentinel", async () => {
    await loadRateCard(VIEWER);
    const ctx = mockInvoke.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(ctx.workspaceId).toBe("00000000-0000-0000-0000-000000000000");
    expect(ctx.surface).toBe("app");
  });
});

describe("the three reads — degrade, never fabricate", () => {
  it("returns ok:false with the message instead of an empty output shape", async () => {
    mockInvoke.mockRejectedValue(new Error("ClickHouse unavailable"));
    const result = await loadActionUsage(VIEWER);
    expect(result).toEqual({ ok: false, error: "ClickHouse unavailable" });
    // Critically NOT a zeroed BillingActionUsageOutput — a zero on a billing
    // page is a claim about the customer's account.
    expect(result).not.toHaveProperty("data");
  });

  it("falls back to a plain message for a non-Error throw", async () => {
    mockInvoke.mockRejectedValue("nope");
    const result = await loadRateCard(VIEWER);
    expect(result).toEqual({ ok: false, error: "Read failed" });
  });

  it("isolates one failing read from the others", async () => {
    mockInvoke.mockImplementation(async (name: string) => {
      if (name === "get_evidence_retention") throw new Error("down");
      return { fine: true };
    });
    const [usage, rateCard, retention] = await Promise.all([
      loadActionUsage(VIEWER),
      loadRateCard(VIEWER),
      loadEvidenceRetention(VIEWER),
    ]);
    expect(usage.ok).toBe(true);
    expect(rateCard.ok).toBe(true);
    expect(retention.ok).toBe(false);
  });
});
