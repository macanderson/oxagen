// The Spend actions through the real kernel seam (INV-19): the viewer and the
// kernel's invoke() are the only fakes, so each case shows what the person
// gets back and whether the capability ran.
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { findingDismiss } from "@oxagen/oxagen/contracts/finding.dismiss";
import { findingFixRecord } from "@oxagen/oxagen/contracts/finding.fix.record";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
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
const {
  dismissFindingAction,
  exportStatementAction,
  recordFindingFixAction,
  setBudgetAction,
  setGatewayPolicyAction,
  setPriceEntryAction,
} = await import("./actions");

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
  wsRole: "member",
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

const finding = {
  id: "fnd_01k5rtgh",
  kind: "unpaged_results",
  level: "tool",
  subject: "aws_billing__get_cost_and_usage",
  saving: {
    micros: "984600000",
    currency: "USD",
    basis: "gateway_observed",
  },
  confidence: "high",
  window: {
    from: "2026-08-16T00:00:00.000Z",
    to: "2026-09-15T00:00:00.000Z",
  },
  why: "Each run requests thirty days of line items unpaged.",
  fix: "Request grouped totals; page line items only on drill-down.",
  runs: 88,
  calls: 3106,
  status: "open",
  detectedAt: "2026-09-15T02:00:00.000Z",
  decidedAt: null,
  appliedActionId: null,
};

describe("recordFindingFixAction", () => {
  it("resolves the viewer and refuses an id no finding carries, recording nothing (negative)", async () => {
    expect(await recordFindingFixAction(at, "01k5rtgh")).toEqual({
      ok: false,
      reason: "invalid",
      code: "findingInvalid",
      field: "findingId",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(forbidden());
    expect(await recordFindingFixAction(at, "fnd_01k5rtgh")).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("records the change through record_finding_fix", async () => {
    invoke.mockResolvedValue({
      finding: {
        ...finding,
        status: "applied",
        decidedAt: "2026-09-15T12:00:00.000Z",
        appliedActionId: "req_01k5",
      },
    });
    expect(await recordFindingFixAction(at, "fnd_01k5rtgh")).toEqual({
      ok: true,
      value: null,
    });
    expect(invoke).toHaveBeenCalledWith(
      findingFixRecord.name,
      { findingId: "fnd_01k5rtgh" },
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
    );
  });
});

describe("dismissFindingAction", () => {
  it("refuses an id no finding carries, dismissing nothing (negative)", async () => {
    expect(await dismissFindingAction(at, "arun_01k5rtgh")).toEqual({
      ok: false,
      reason: "invalid",
      code: "findingInvalid",
      field: "findingId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a finding already decided as the kernel classified it (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "finding_not_open",
        message: "This finding was already decided",
      }),
    );
    expect(await dismissFindingAction(at, "fnd_01k5rtgh")).toEqual({
      ok: false,
      reason: "conflict",
      code: "finding_not_open",
    });
  });

  it("closes the finding through dismiss_finding", async () => {
    invoke.mockResolvedValue({
      finding: {
        ...finding,
        status: "dismissed",
        decidedAt: "2026-09-15T12:00:00.000Z",
      },
    });
    expect(await dismissFindingAction(at, "fnd_01k5rtgh")).toEqual({
      ok: true,
      value: null,
    });
    expect(invoke).toHaveBeenCalledWith(
      findingDismiss.name,
      { findingId: "fnd_01k5rtgh" },
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
    );
  });
});

describe("atomic price card action", () => {
  const rate = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: "",
    region: "",
    tokenClass: "input_uncached",
    usdPerMillion: "3",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
  };
  it("sends all validated classes through one kernel write", async () => {
    invoke.mockResolvedValue({});
    await setPriceEntryAction(at, rate, [
      { ...rate, tokenClass: "output", usdPerMillion: "15" },
    ]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toBe("set_price_entry");
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      additionalRates: [{ tokenClass: "output", usdPerMillion: 15 }],
    });
  });
  it("refuses an invalid later class before writing the first", async () => {
    const result = await setPriceEntryAction(at, rate, [
      { ...rate, tokenClass: "output", usdPerMillion: "bad" },
    ]);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("setGatewayPolicyAction", () => {
  // The form's own refusals reach the person through this action, so each one
  // has to arrive naming the field that holds it. The dialog puts a named
  // field on that field and an unnamed one in the alert, so an action that
  // dropped the name would turn a typo into a whole-form failure.
  const gateway = {
    mode: "enforced" as const,
    sessionLimit: "",
    modelAllow: "",
    modelDeny: "",
  };

  it("refuses enforced with nothing to enforce, naming the mode, and sets nothing (negative)", async () => {
    expect(await setGatewayPolicyAction(at, gateway)).toEqual({
      ok: false,
      reason: "invalid",
      code: "nothingToEnforce",
      field: "mode",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a model pattern the host could not apply, naming its list (negative)", async () => {
    expect(
      await setGatewayPolicyAction(at, {
        ...gateway,
        modelDeny: "gpt-4o\nclaude-*-turbo",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "modelPatternInvalid",
      field: "modelDeny",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(forbidden());
    expect(
      await setGatewayPolicyAction(at, { ...gateway, sessionLimit: "10" }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });

  it("sends a blank allowlist as null and answers with the reach, not just saved", async () => {
    // Blank is *no allowlist*, so every model stays permitted; an empty array
    // would mean permit nothing. The two must not share an encoding on the
    // wire, and the answer carries reach because a saved list that no machine
    // can read is not a list in force.
    invoke.mockResolvedValue({
      mode: "enforced",
      sessionLimitUsd: 10,
      modelAllow: null,
      modelDeny: ["gpt-4o"],
      reach: { hosts: 3, hostsEnforcingModels: 1 },
    });
    expect(
      await setGatewayPolicyAction(at, {
        ...gateway,
        sessionLimit: "10",
        modelDeny: "gpt-4o",
      }),
    ).toEqual({ ok: true, value: { hosts: 3, hostsEnforcingModels: 1 } });
    expect(invoke).toHaveBeenCalledWith(
      tachoSessionPolicyWrite.name,
      {
        mode: "enforced",
        sessionLimitUsd: 10,
        modelAllow: null,
        modelDeny: ["gpt-4o"],
      },
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      }),
    );
  });
});
