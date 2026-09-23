// The two mandate writes through the real kernel seam: the viewer resolution and
// the kernel's invoke() are the only fakes, so each case shows what the person
// gets back, whether the capability ran, and with which input (INV-19).
//
// The refusals matter most. `update_mandate_limits` and `revoke_mandate` are
// governed writes on financial authority, and the gate lives in each handler
// (`assertConsequenceRole` then `assertOrgRole`), not in the action and not in
// the page. What the app owes is that a denial comes back as a denial with
// nothing changed.
//
// `changeMandateLimits` reads the mandate first, for one reason: the kind of the
// measure it edits (ADR-108). A money figure is typed as a decimal and stored as
// micros. A count is stored as typed. The cases below pin that the kind comes
// from the record and never from the browser, and that the patch is sparse: a
// field left blank or equal to the value it opened with is not sent, because the
// handler reads every field a change carries as an edit (ADR-102).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorityOutput,
  callsAuthorityOutput,
  MANDATE_ID,
  mandateGetOutput,
  mandateOutput,
} from "@/test/mandate-outputs";

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
const { changeMandateLimits, revokeMandate } = await import("./actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "a-intel",
  orgName: "Anderson Intelligence Corp.",
  orgRole: "billing",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** The CapabilityContext every write reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

/** $250 a call, $2,000 a month, approval above $100 and always for moves_money. */
const stored = mandateOutput({
  approval: {
    humanAbove: { amount: "100000000" },
    alwaysHumanFor: ["moves_money"],
    approvers: ["role:Billing"],
  },
  authority: [authorityOutput(), callsAuthorityOutput()],
});

/**
 * The kernel answers by capability: `get_mandate` for the kind, the viewer's
 * zone when the submission carries a day, and the write.
 */
function kernelAnswers(
  options: { readThrows?: Error; writeThrows?: Error; timezone?: string } = {},
) {
  invoke.mockImplementation((name: string) => {
    if (name === "get_mandate")
      return options.readThrows !== undefined
        ? Promise.reject(options.readThrows)
        : Promise.resolve(mandateGetOutput([], stored));
    if (name === "get_user_preferences")
      return Promise.resolve({
        fontSize: "medium",
        density: "comfortable",
        enterToSubmit: true,
        pendingPromptBehavior: "queue",
        defaultTextTier: null,
        defaultTextModel: null,
        timezone: options.timezone ?? "America/Los_Angeles",
        language: "en",
        theme: "system",
      });
    if (options.writeThrows !== undefined)
      return Promise.reject(options.writeThrows);
    return Promise.resolve(mandateOutput());
  });
}

/** The one `update_mandate_limits` call's input, or undefined when none was made. */
function written(): unknown {
  return invoke.mock.calls.find(
    ([name]) => name === "update_mandate_limits",
  )?.[1];
}

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

const OPENED = {
  perCall: "250.00",
  perPeriod: "2000.00",
  approvalAbove: "100.00",
};

/** The dialog submitted untouched: every field still its prefill. */
const untouched = {
  mandateId: MANDATE_ID,
  measure: "amount",
  ...OPENED,
  validTo: "",
  baseline: OPENED,
};

describe("changeMandateLimits", () => {
  it("scales a money figure to micros by the kind the record carries, and sends only it", async () => {
    kernelAnswers();
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        perPeriod: "1,500.50",
      }),
    ).toEqual({ ok: true, value: { mandateId: MANDATE_ID, status: "active" } });
    expect(requireViewer).toHaveBeenCalledWith("a-intel", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "get_mandate",
      { mandateId: MANDATE_ID, ledgerLimit: 1 },
      expect.objectContaining(TENANT),
    );
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { amount: { perPeriod: "1500500000" } },
    });
  });

  it("stores a count digit for digit", async () => {
    kernelAnswers();
    await changeMandateLimits("a-intel", "core-platform", {
      mandateId: MANDATE_ID,
      measure: "calls",
      perCall: "",
      perPeriod: "80",
      approvalAbove: "",
      validTo: "",
      baseline: { perCall: "", perPeriod: "50", approvalAbove: "" },
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { calls: { perPeriod: "80" } },
    });
  });

  // The browser names the measure and nothing about its kind. A request naming
  // a measure the record does not limit is refused before any write.
  it("refuses a measure the mandate does not limit (negative)", async () => {
    kernelAnswers();
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        measure: "tokens",
        perPeriod: "9",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "measure",
    });
    expect(written()).toBeUndefined();
  });

  it("changes the approval threshold and carries every other clause of the rule as stored", async () => {
    kernelAnswers();
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      approvalAbove: "75",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      approval: {
        humanAbove: { amount: "75000000" },
        alwaysHumanFor: ["moves_money"],
        approvers: ["role:Billing"],
      },
    });
  });

  it("sends a validity end as the close of that day in the viewer's zone", async () => {
    kernelAnswers({ timezone: "UTC" });
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      validTo: "2027-03-31",
    });
    const input = written() as { validTo: string; limitChanges?: unknown };
    expect(input.limitChanges).toBeUndefined();
    expect(Date.parse(input.validTo)).toBe(
      Date.parse("2027-03-31T23:59:59.999Z"),
    );
  });

  it("refuses a submission that changed nothing, before any write (negative)", async () => {
    kernelAnswers();
    expect(
      await changeMandateLimits("a-intel", "core-platform", untouched),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "perPeriod",
    });
    expect(written()).toBeUndefined();
  });

  it("reads a cleared field as keep, never as delete", async () => {
    kernelAnswers();
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      perCall: "",
      perPeriod: "900",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { amount: { perPeriod: "900000000" } },
    });
  });

  it("refuses a figure that is not a figure, naming its field (negative)", async () => {
    kernelAnswers();
    for (const [field, value] of [
      ["perCall", "-5"],
      ["perPeriod", "1e9"],
      ["approvalAbove", "ten"],
    ] as const) {
      expect(
        await changeMandateLimits("a-intel", "core-platform", {
          ...untouched,
          [field]: value,
        }),
      ).toEqual({ ok: false, reason: "invalid", code: "invalid_input", field });
    }
    expect(written()).toBeUndefined();
  });

  it("refuses a day that does not exist before reading anything (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        validTo: "2027-02-31",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "validTo",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers a reader the read refuses with that refusal, and writes nothing (negative)", async () => {
    kernelAnswers({
      readThrows: new kernel.CapabilityError(
        "get_mandate",
        "authz_denied",
        "denied",
      ),
    });
    const result = await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      perPeriod: "900",
    });
    expect(result).toMatchObject({ ok: false, reason: "denied" });
    expect(written()).toBeUndefined();
  });

  it("changes nothing when the handler's role check refuses the write (negative)", async () => {
    kernelAnswers({
      writeThrows: new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "an accountable org role is required",
      }),
    });
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        perPeriod: "900",
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});

describe("revokeMandate", () => {
  const input = { mandateId: MANDATE_ID, reason: "  vendor contract ended  " };

  it("revokes with the reason trimmed, for the workspace viewer", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "revoked" });
    expect(await revokeMandate("a-intel", "core-platform", input)).toEqual({
      ok: true,
      value: { mandateId: MANDATE_ID, status: "revoked" },
    });
    expect(requireViewer).toHaveBeenCalledWith("a-intel", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "revoke_mandate",
      { mandateId: MANDATE_ID, reason: "vendor contract ended" },
      expect.objectContaining(TENANT),
    );
  });

  // The reason is the audit record's account of why authority ended, so a blank
  // one is refused here rather than stored as an empty string.
  it("refuses a blank reason before the kernel runs (negative)", async () => {
    expect(
      await revokeMandate("a-intel", "core-platform", {
        mandateId: MANDATE_ID,
        reason: "   ",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  // A refused revoke must leave the ledger alone. The handler does its role
  // check before it locks the row, so the evidence the app can hold is that
  // exactly one call was made, it was refused, and no mandate came back — there
  // is no second call and no value for a caller to act on.
  it("changes nothing when the role check refuses it (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "an accountable org role is required",
      }),
    );
    const result = await revokeMandate("a-intel", "core-platform", input);
    expect(result).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(result).not.toHaveProperty("value");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports a mandate nobody recorded as not found (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "not_found",
        reason: "mandate_not_found",
        message: "no such mandate",
      }),
    );
    expect(await revokeMandate("a-intel", "core-platform", input)).toEqual({
      ok: false,
      reason: "not_found",
      code: "mandate_not_found",
    });
  });

  it("reports a mandate that has already ended as a conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "mandate_ended",
        message: "already revoked",
      }),
    );
    expect(await revokeMandate("a-intel", "core-platform", input)).toEqual({
      ok: false,
      reason: "conflict",
      code: "mandate_ended",
    });
  });
});
