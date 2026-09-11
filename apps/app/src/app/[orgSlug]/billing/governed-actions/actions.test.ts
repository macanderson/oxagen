/**
 * actions.test.ts — unit tests for `previewActionCostAction`.
 *
 * `apps/app` does not bootstrap kernel IAM, so this action's own role gate is
 * the only thing standing between a plain org member and a billing read. The
 * first two describes are that gate; the rest cover input validation, the
 * omitted-vs-supplied override distinction the contract depends on, and the
 * invoke failure path.
 *
 * Mocking strategy mirrors `../actions.test.ts`:
 *   - @/lib/session, @/lib/resolve-org → vi.mock
 *   - @oxagen/tenancy → runInTenantScope runs its callback inline
 *   - @oxagen/oxagen → invoke stubbed
 *   - @oxagen/handlers/register → no-op (the real one loads the whole kernel)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke, mockGetSession, mockResolveOrg, mockGetOrgRole } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockGetOrgRole: vi.fn(),
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
  getOrgRole: mockGetOrgRole,
  BILLING_MANAGER_ROLES: new Set(["owner", "admin", "billing"]),
}));

import { previewActionCostAction } from "./actions";

const ESTIMATE = {
  assumptions: {
    runsPerYear: 1000,
    actionsPerRun: 15,
    actionsPerRunSource: "run_class",
    runClass: "standard_task",
    tier: "scale",
  },
  actionsPerYear: 15_000,
  includedActionsAnnual: 1_000_000,
  overageActions: 0,
  band: { id: "0-1m", usdPer1000: 20 },
  overageUsd: 0,
  excludes: "…",
};

const VALID = {
  orgSlug: "acme",
  runsPerYear: 1000,
  runClass: "standard_task" as const,
  tier: "scale" as const,
};

beforeEach(() => {
  mockInvoke.mockReset().mockResolvedValue(ESTIMATE);
  mockResolveOrg.mockReset().mockResolvedValue({ id: "org-1", slug: "acme" });
  mockGetSession.mockReset().mockResolvedValue({ user: { id: "user-1" } });
  mockGetOrgRole.mockReset().mockResolvedValue("owner");
});

describe("previewActionCostAction — authorization", () => {
  it("denies an anonymous caller before resolving a role", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await previewActionCostAction(VALID);
    expect(result).toEqual({
      ok: false,
      error: "You don't have permission to read billing for this organization.",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies a plain org member — membership alone is not a billing read", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    const result = await previewActionCostAction(VALID);
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies a non-member (no role row at all)", async () => {
    mockGetOrgRole.mockResolvedValue(null);
    const result = await previewActionCostAction(VALID);
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "billing"])("allows the %s role", async (role) => {
    mockGetOrgRole.mockResolvedValue(role);
    const result = await previewActionCostAction(VALID);
    expect(result).toEqual({ ok: true, data: ESTIMATE });
  });
});

describe("previewActionCostAction — input validation", () => {
  it("rejects a zero or negative run volume", async () => {
    for (const runsPerYear of [0, -5]) {
      const result = await previewActionCostAction({ ...VALID, runsPerYear });
      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    }
  });

  it("rejects a fractional run volume", async () => {
    const result = await previewActionCostAction({
      ...VALID,
      runsPerYear: 10.5,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an override above the contract's ceiling", async () => {
    const result = await previewActionCostAction({
      ...VALID,
      actionsPerRun: 10_001,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects an unknown run class", async () => {
    const result = await previewActionCostAction({
      ...VALID,
      // Deliberately outside the enum — the client is not trusted to hold it.
      runClass: "freeform" as unknown as typeof VALID.runClass,
    });
    expect(result.ok).toBe(false);
  });
});

describe("previewActionCostAction — the measured-ratio distinction", () => {
  it("omits actionsPerRun entirely when none was supplied", async () => {
    await previewActionCostAction(VALID);
    const input = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    // The handler branches on presence, not on value: sending `undefined`
    // would still be a supplied key on some transports.
    expect(Object.hasOwn(input, "actionsPerRun")).toBe(false);
    expect(input).toMatchObject({ runsPerYear: 1000, tier: "scale" });
  });

  it("forwards a supplied ratio so the handler can report it as measured", async () => {
    await previewActionCostAction({ ...VALID, actionsPerRun: 42 });
    const input = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({ actionsPerRun: 42 });
  });

  it("invokes the capability on the agent surface (the app is not a declared surface)", async () => {
    await previewActionCostAction(VALID);
    expect(mockInvoke).toHaveBeenCalledWith(
      "preview_action_cost",
      expect.anything(),
      expect.objectContaining({ orgId: "org-1", userId: "user-1" }),
      { surface: "agent" },
    );
  });
});

describe("previewActionCostAction — failure", () => {
  it("returns the kernel's message rather than throwing into the client", async () => {
    mockInvoke.mockRejectedValue(new Error("band resolution failed"));
    const result = await previewActionCostAction(VALID);
    expect(result).toEqual({ ok: false, error: "band resolution failed" });
  });

  it("falls back to a plain message for a non-Error throw", async () => {
    mockInvoke.mockRejectedValue("boom");
    const result = await previewActionCostAction(VALID);
    expect(result).toEqual({
      ok: false,
      error: "The estimate could not be calculated.",
    });
  });
});
