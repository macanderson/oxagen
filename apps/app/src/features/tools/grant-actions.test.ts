// The grant through the real kernel seam: the viewer resolution, the saved-zone
// read and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether grant_mandate ran. A field the action refuses is
// refused before the kernel and named; a handler refusal comes back with its
// reason and nothing granted (INV-19).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANDATE_ID, mandateOutput } from "@/test/mandate-outputs";

const { invoke, requireViewer, kernelRead } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
  kernelRead: vi.fn(),
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
// The write runs through the real seam; the one read a grant makes, the
// person's saved zone, is faked here so `invoke` answers the write alone.
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelRead,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { grantMandate } = await import("./grant-actions");

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

const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

const draft = {
  agentId: " agt_invoicebot ",
  requestId: null,
  consequenceTags: "moves_money, communicates_externally, moves_money",
  measure: "rows",
  unit: "rows",
  perCall: "50",
  perPeriod: "1000",
  period: "monthly" as const,
  callsPerDay: "40",
  tools: "stripe__create_payment@*, mailer__send@2",
  targetMeasure: "recipient",
  targetAllow: "vendor:aws, vendor:github",
  targetDeny: "*",
  alwaysHumanFor: "communicates_externally",
  humanAboveMeasure: "rows",
  humanAboveValue: "500",
  approvers: "role:Billing, user:usr_priyanatarajan",
  purpose: "  monthly infrastructure invoices, PO-4471  ",
  validFrom: "2026-09-01",
  validTo: "2026-12-31",
};

/** The body grant_mandate receives for `draft` in UTC. */
const BODY = {
  agentId: "agt_invoicebot",
  consequenceTags: ["moves_money", "communicates_externally"],
  limits: {
    rows: {
      perCall: "50",
      perPeriod: "1000",
      period: "monthly",
      currencyOrUnit: "rows",
    },
    calls: { perPeriod: "40", period: "daily", currencyOrUnit: "calls" },
  },
  targets: {
    recipient: { allow: ["vendor:aws", "vendor:github"], deny: ["*"] },
  },
  tools: ["stripe__create_payment@*", "mailer__send@2"],
  approval: {
    humanAbove: { rows: "500" },
    alwaysHumanFor: ["communicates_externally"],
    approvers: ["role:Billing", "user:usr_priyanatarajan"],
  },
  purpose: "monthly infrastructure invoices, PO-4471",
  validFrom: "2026-09-01T00:00:00.000Z",
  validTo: "2026-12-31T23:59:59.999Z",
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
  kernelRead.mockReset();
  kernelRead.mockResolvedValue({ ok: true, value: { timezone: "UTC" } });
});

describe("grantMandate", () => {
  it("grants the whole mandate as typed, for the workspace viewer", async () => {
    invoke.mockResolvedValue(mandateOutput());
    expect(await grantMandate("acme", "core-platform", draft)).toEqual({
      ok: true,
      value: { mandateId: MANDATE_ID, status: "active" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "grant_mandate",
      BODY,
      expect.objectContaining(TENANT),
    );
  });

  it("activates a requested draft by sending its id", async () => {
    invoke.mockResolvedValue(mandateOutput());
    await grantMandate("acme", "core-platform", {
      ...draft,
      requestId: MANDATE_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      "grant_mandate",
      { ...BODY, requestId: MANDATE_ID },
      expect.objectContaining(TENANT),
    );
  });

  it("sends empty rules when the optional sections are blank", async () => {
    invoke.mockResolvedValue(mandateOutput());
    await grantMandate("acme", "core-platform", {
      ...draft,
      measure: "",
      unit: "",
      perCall: "",
      perPeriod: "",
      targetMeasure: "",
      targetAllow: "",
      targetDeny: "",
      alwaysHumanFor: "",
      humanAboveMeasure: "",
      humanAboveValue: "",
      approvers: "",
    });
    expect(invoke).toHaveBeenCalledWith(
      "grant_mandate",
      expect.objectContaining({
        limits: {
          calls: { perPeriod: "40", period: "daily", currencyOrUnit: "calls" },
        },
        targets: {},
        approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
      }),
      expect.objectContaining(TENANT),
    );
  });

  it("places the picked days in the viewer's saved zone", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "Asia/Tokyo" },
    });
    invoke.mockResolvedValue(mandateOutput());
    await grantMandate("acme", "core-platform", draft);
    expect(invoke).toHaveBeenCalledWith(
      "grant_mandate",
      expect.objectContaining({
        validFrom: "2026-08-31T15:00:00.000Z",
        validTo: "2026-12-31T14:59:59.999Z",
      }),
      expect.objectContaining(TENANT),
    );
  });

  it.each([
    ["agentId", { agentId: "  " }],
    ["consequenceTags", { consequenceTags: "" }],
    ["consequenceTags", { consequenceTags: "Moves Money" }],
    ["measure", { measure: "calls" }],
    ["measure", { measure: "Rows Read" }],
    ["unit", { unit: "u".repeat(33) }],
    ["unit", { unit: "usd" }],
    ["perCall", { perCall: "12.50" }],
    ["perPeriod", { perCall: "", perPeriod: "" }],
    ["callsPerDay", { callsPerDay: "0050" }],
    ["tools", { tools: " , " }],
    ["targetMeasure", { targetMeasure: "" }],
    ["targetMeasure", { targetMeasure: "calls" }],
    ["targetMeasure", { targetMeasure: "Recipient" }],
    ["targetAllow", { targetAllow: "", targetDeny: "" }],
    ["targetAllow", { targetAllow: "x".repeat(257) }],
    ["targetDeny", { targetDeny: "y".repeat(257) }],
    ["alwaysHumanFor", { alwaysHumanFor: "Moves-Money" }],
    ["humanAboveValue", { humanAboveValue: "" }],
    ["humanAboveMeasure", { humanAboveMeasure: "" }],
    ["humanAboveValue", { humanAboveValue: "5e2" }],
    ["humanAboveMeasure", { humanAboveMeasure: "rows-read" }],
    ["approvers", { approvers: "role:Member" }],
    ["approvers", { approvers: "priya" }],
    ["purpose", { purpose: "   " }],
    ["validFrom", { validFrom: "09/01/2026" }],
    ["validTo", { validTo: "" }],
    ["validTo", { validFrom: "2026-12-31", validTo: "2026-09-01" }],
  ])(
    "refuses a bad %s before the kernel, naming the field (negative)",
    async (field, change) => {
      expect(
        await grantMandate("acme", "core-platform", { ...draft, ...change }),
      ).toEqual({ ok: false, reason: "invalid", code: "invalid_input", field });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses when the saved zone cannot be read, rather than guessing one (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "control_plane_unavailable",
      status: 503,
    });
    expect(await grantMandate("acme", "core-platform", draft)).toEqual({
      ok: false,
      reason: "unavailable",
      code: "time_zone_unavailable",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["forbidden", "org_role_required", "denied"],
    ["forbidden", "no_role_covers_all_tags", "denied"],
    ["not_found", "agent_not_found", "not_found"],
    ["conflict", "no_tool_matches", "conflict"],
    ["conflict", "measure_not_declared", "conflict"],
    ["conflict", "not_a_draft", "conflict"],
  ] as const)(
    "carries the handler's %s refusal %s back with nothing granted (negative)",
    async (code, reason, expected) => {
      invoke.mockRejectedValue(
        new kernel.HandlerError({ code, reason, message: reason }),
      );
      expect(await grantMandate("acme", "core-platform", draft)).toEqual({
        ok: false,
        reason: expected,
        code: reason,
      });
    },
  );
});
