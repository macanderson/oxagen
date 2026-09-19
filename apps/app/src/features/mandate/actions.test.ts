// The two mandate writes through the real kernel seam: the viewer resolution and
// the kernel's invoke() are the only fakes, so each case shows what the person
// gets back, whether the capability ran, and with which input (INV-19).
//
// The cases that matter most here are the refusals. `update_mandate_limits` and
// `revoke_mandate` are governed writes on financial authority, and the gate lives
// in each handler (`assertConsequenceRole` → `assertOrgRole`), not in the action
// and not in the page: IAM fast-paths a non-enterprise org to an unconditional
// allow for a human principal, so "the kernel ran" is not "the role was checked".
// What the app owes is that a denial comes back as a denial with nothing changed,
// which is what the denied cases below pin — including that a refused revoke
// sends exactly one call and gets no mandate back, so no ledger row could have
// moved.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ledgerOutput,
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

const denied = (name: string) =>
  new kernel.CapabilityError(name, "authz_denied", "denied");

/**
 * `changeMandateLimits` makes two kernel calls: it reads the mandate to get the
 * stored limits, then writes the merged record. The stub answers by capability
 * name so a test can say what is stored and what the write answered, and so a
 * test asserting the write's input is asserting the merge rather than the form.
 */
function kernelAnswers(options: {
  stored?: Parameters<typeof mandateOutput>[0];
  write?: unknown;
  readThrows?: unknown;
  writeThrows?: unknown;
}) {
  invoke.mockImplementation((name) => {
    if (name === "get_mandate") {
      if (options.readThrows !== undefined)
        return Promise.reject(options.readThrows);
      return Promise.resolve(
        mandateGetOutput([ledgerOutput()], mandateOutput(options.stored)),
      );
    }
    if (options.writeThrows !== undefined)
      return Promise.reject(options.writeThrows);
    return Promise.resolve(options.write ?? mandateOutput());
  });
}

/** The one `update_mandate_limits` call's input. */
function writtenLimits(): unknown {
  const call = invoke.mock.calls.find(
    ([name]) => name === "update_mandate_limits",
  );
  if (!call) throw new Error("update_mandate_limits was not called");
  return call[1];
}

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("changeMandateLimits", () => {
  const draft = {
    mandateId: MANDATE_ID,
    measure: "rows",
    unit: "rows",
    perCall: "50",
    perPeriod: "1000",
    period: "monthly" as const,
    callsPerDay: "40",
    validTo: "2026-12-31",
  };

  /** The stored record the fixture carries: one monthly amount limit in USD. */
  const STORED_AMOUNT = {
    perCall: "250000000",
    perPeriod: "2000000000",
    period: "monthly",
    currencyOrUnit: "USD",
  };

  it("writes the edit merged over the stored record, with the window's last day", async () => {
    kernelAnswers({});
    expect(await changeMandateLimits("a-intel", "core-platform", draft)).toEqual(
      { ok: true, value: { mandateId: MANDATE_ID, status: "active" } },
    );
    expect(requireViewer).toHaveBeenCalledWith("a-intel", "core-platform");
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      limits: {
        // Untouched, and resubmitted exactly as recorded.
        amount: STORED_AMOUNT,
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
        calls: {
          perPeriod: "40",
          period: "daily",
          currencyOrUnit: "calls",
        },
      },
      // The last day runs through its end, so a window to 2026-12-31 expires
      // as that day ends rather than as it begins.
      validTo: "2026-12-31T23:59:59.999Z",
    });
    expect(invoke).toHaveBeenCalledWith(
      "get_mandate",
      { mandateId: MANDATE_ID, ledgerLimit: 1 },
      expect.objectContaining(TENANT),
    );
  });

  // The defect this exists for: `update_mandate_limits` SETS `limits`, so an
  // edit naming one measure would delete the bounds on the others, and a deleted
  // bound is unbounded authority for that measure. Editing one measure of a
  // two-measure mandate must leave the other's bound present and unchanged.
  it("keeps every bound the edit did not name, digit for digit", async () => {
    kernelAnswers({
      stored: {
        limits: {
          amount: {
            perCall: "250000000",
            perPeriod: "2000000000",
            period: "monthly",
            currencyOrUnit: "USD",
          },
          recipients: {
            perCall: "25",
            perPeriod: "500",
            period: "weekly",
            currencyOrUnit: "recipients",
          },
        },
      },
    });
    await changeMandateLimits("a-intel", "core-platform", {
      ...draft,
      measure: "recipients",
      unit: "recipients",
      perCall: "10",
      perPeriod: "200",
      period: "weekly",
      callsPerDay: "",
      validTo: "",
    });
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      limits: {
        // The money measure the form cannot express, carried through untouched.
        amount: STORED_AMOUNT,
        recipients: {
          perCall: "10",
          perPeriod: "200",
          period: "weekly",
          currencyOrUnit: "recipients",
        },
      },
    });
  });

  it("keeps a sublimit the edit left blank, not just a sibling measure", async () => {
    kernelAnswers({
      stored: {
        limits: {
          recipients: {
            perCall: "25",
            perPeriod: "500",
            period: "weekly",
            currencyOrUnit: "recipients",
          },
        },
      },
    });
    // The operator clears the per-call box and leaves the period figure.
    await changeMandateLimits("a-intel", "core-platform", {
      ...draft,
      measure: "recipients",
      unit: "recipients",
      perCall: "",
      perPeriod: "400",
      period: "weekly",
      callsPerDay: "",
      validTo: "",
    });
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      limits: {
        recipients: {
          // Still bounded per call. A blank box leaves the bound as it is, which
          // is what the dialog says, and dropping it would be unbounded
          // authority for that sublimit.
          perCall: "25",
          perPeriod: "400",
          period: "weekly",
          currencyOrUnit: "recipients",
        },
      },
    });
  });

  it("keeps the stored window of a calls cap the form cannot express", async () => {
    kernelAnswers({
      stored: {
        limits: {
          calls: {
            perPeriod: "10",
            period: "weekly",
            currencyOrUnit: "calls",
          },
        },
      },
    });
    // The form shows the calls cap as a bare number with no period control, so
    // this submission says nothing about the window. Ten a week must not become
    // ten a day.
    await changeMandateLimits("a-intel", "core-platform", {
      ...draft,
      measure: "",
      unit: "",
      perCall: "",
      perPeriod: "",
      callsPerDay: "10",
      validTo: "",
    });
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      limits: {
        calls: { perPeriod: "10", period: "weekly", currencyOrUnit: "calls" },
      },
    });
  });

  it("does not read the record when there is no limit to merge into (negative)", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...draft,
      measure: "",
      unit: "",
      perCall: "",
      perPeriod: "",
      callsPerDay: "",
      validTo: "2027-01-31",
    });
    expect(
      invoke.mock.calls.filter(([name]) => name === "get_mandate"),
    ).toHaveLength(0);
  });

  // The merge is authoritative only if it comes from the store, so a read that
  // did not answer stops the write rather than falling back to the edit alone.
  it("writes nothing when the record could not be read (negative)", async () => {
    kernelAnswers({
      readThrows: new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "an accountable org role is required",
      }),
    });
    expect(await changeMandateLimits("a-intel", "core-platform", draft)).toEqual(
      { ok: false, reason: "denied", code: "org_role_required" },
    );
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  it("reports a mandate nobody recorded as not found, from the read (negative)", async () => {
    kernelAnswers({
      readThrows: new kernel.HandlerError({
        code: "not_found",
        reason: "mandate_not_found",
        message: "no such mandate",
      }),
    });
    expect(await changeMandateLimits("a-intel", "core-platform", draft)).toEqual(
      { ok: false, reason: "not_found", code: "mandate_not_found" },
    );
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  // The figure typed is the figure stored. Scaling one to micros is correct only
  // for a measure a tool declares as an `amount`, and no read answers that, so a
  // form that scaled could store a millionfold wider bound than was entered.
  it("stores the figure exactly as typed, digit for digit", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...draft,
      perCall: "50",
      perPeriod: "1000",
      callsPerDay: "",
      validTo: "",
    });
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      limits: {
        amount: STORED_AMOUNT,
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
      },
    });
  });

  it("changes the window alone, with no limits record, when only a date is given", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      mandateId: MANDATE_ID,
      measure: "",
      unit: "",
      perCall: "",
      perPeriod: "",
      period: "monthly",
      callsPerDay: "",
      validTo: "2027-01-31",
    });
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      validTo: "2027-01-31T23:59:59.999Z",
    });
  });

  it("writes a calls cap on its own, over the record's other measures", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      mandateId: MANDATE_ID,
      measure: "",
      unit: "",
      perCall: "",
      perPeriod: "",
      period: "monthly",
      callsPerDay: "500",
      validTo: "",
    });
    expect(writtenLimits()).toEqual({
      mandateId: MANDATE_ID,
      limits: {
        amount: STORED_AMOUNT,
        calls: {
          perPeriod: "500",
          period: "daily",
          currencyOrUnit: "calls",
        },
      },
    });
  });

  // A limit denominated in an ISO 4217 code reads back as money while the figure
  // beside it is whole units: the one shape this form cannot write correctly.
  it("refuses a currency unit in either casing, before the kernel runs (negative)", async () => {
    for (const unit of ["USD", "usd"]) {
      expect(
        await changeMandateLimits("a-intel", "core-platform", {
          ...draft,
          unit,
        }),
      ).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "unit",
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  // `calls` is the built-in measure: every call draws exactly one of it whatever
  // a limit says, and the grant handler exempts it from the declared-measure
  // check, so nothing downstream would catch a rows limit filed under that name.
  it("refuses the reserved measure name (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...draft,
        measure: "calls",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "measure",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a figure that is not an integer string (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...draft,
        perCall: "50.5",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "perCall",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a change that names nothing at all (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        mandateId: MANDATE_ID,
        measure: "",
        unit: "",
        perCall: "",
        perPeriod: "",
        period: "monthly",
        callsPerDay: "",
        validTo: "",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "perPeriod",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a date that is not a day (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...draft,
        validTo: "next year",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "validTo",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  // The handler's own gate: a caller whose roles are not accountable for the
  // mandate's consequences is refused before any row is touched, and the app
  // reports it as a denial rather than as a page error.
  it("reports the write handler's role refusal as a denial (negative)", async () => {
    kernelAnswers({
      writeThrows: new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "an accountable org role is required",
      }),
    });
    expect(await changeMandateLimits("a-intel", "core-platform", draft)).toEqual(
      { ok: false, reason: "denied", code: "org_role_required" },
    );
  });

  it("reports an IAM denial as a denial (negative)", async () => {
    kernelAnswers({ writeThrows: denied("update_mandate_limits") });
    expect(await changeMandateLimits("a-intel", "core-platform", draft)).toEqual(
      { ok: false, reason: "denied", code: "authz_denied" },
    );
  });

  it("reports a mandate that has already ended as a conflict (negative)", async () => {
    kernelAnswers({
      writeThrows: new kernel.HandlerError({
        code: "conflict",
        reason: "mandate_ended",
        message: "already revoked",
      }),
    });
    expect(await changeMandateLimits("a-intel", "core-platform", draft)).toEqual(
      { ok: false, reason: "conflict", code: "mandate_ended" },
    );
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
