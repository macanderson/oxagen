// The Spend actions through the real kernel seam (INV-19): the viewer and the
// kernel's invoke() are the only fakes, so each case shows what the person
// gets back and whether the capability ran.
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { exportStatementAction, setBudgetAction } = await import("./actions");

const at = { org: "acme", ws: "core-platform" };
const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "billing",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
});
const form = {
  scope: "org" as const,
  period: "monthly" as const,
  windowDays: "",
  limit: "500",
  enabled: true,
};
const forbidden = () =>
  new kernel.HandlerError({
    code: "forbidden",
    reason: "org_role_required",
    message: "Requires one of the org roles Owner, Admin, Billing",
  });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset().mockResolvedValue(ctx);
});

describe("setBudgetAction", () => {
  it("resolves the viewer for the page's workspace and refuses a limit that is not an amount, setting nothing (negative)", async () => {
    expect(await setBudgetAction(at, { ...form, limit: "5,000" })).toEqual({
      ok: false,
      reason: "invalid",
      code: "limitInvalid",
      field: "limit",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(forbidden());
    expect(await setBudgetAction(at, form)).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("sets the ceiling in micro-USD through set_spend_budget", async () => {
    invoke.mockResolvedValue({
      scope: "workspace",
      publicId: "bdg_01",
      enabled: true,
      period: "rolling",
      windowDays: 7,
      limit: { micros: "500250000", currency: "USD" },
      spent: { micros: "0", currency: "USD" },
      projected: { micros: "0", currency: "USD" },
      ratio: 0,
      state: "ok",
      reachedThreshold: 0,
      windowStart: "2026-09-08T00:00:00.000Z",
      windowEnd: "2026-09-15T00:00:00.000Z",
    });
    expect(
      await setBudgetAction(at, {
        ...form,
        scope: "workspace",
        period: "rolling",
        windowDays: "7",
        limit: "500.25",
      }),
    ).toEqual({ ok: true, value: null });
    expect(invoke).toHaveBeenCalledWith(
      billingBudgetSet.name,
      {
        scope: "workspace",
        enabled: true,
        period: "rolling",
        windowDays: 7,
        limit: { micros: "500250000", currency: "USD" },
      },
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      }),
    );
  });
});

describe("exportStatementAction", () => {
  it("refuses a value that is not a month, building nothing (negative)", async () => {
    expect(await exportStatementAction(at, "2026-13")).toEqual({
      ok: false,
      reason: "invalid",
      code: "monthInvalid",
      field: "month",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a kernel denial as denied (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        spendStatementExport.name,
        "authz_denied",
        "denied",
      ),
    );
    expect(await exportStatementAction(at, "2026-09")).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
  });

  it("answers the month's CSV and its file name from export_statement", async () => {
    invoke.mockResolvedValue({
      month: "2026-09",
      filename: "spend-2026-09.csv",
      mediaType: "text/csv",
      content: "level,key\n",
      lines: 0,
    });
    expect(await exportStatementAction(at, "2026-09")).toEqual({
      ok: true,
      value: { filename: "spend-2026-09.csv", content: "level,key\n" },
    });
    expect(invoke).toHaveBeenCalledWith(
      spendStatementExport.name,
      { month: "2026-09", format: "csv" },
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
    );
  });
});
