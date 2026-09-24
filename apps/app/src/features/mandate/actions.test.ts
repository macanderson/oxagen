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
//
// `changeMandateLimits` sends ONE call, carrying only the measures the operator
// changed (`limitChanges`, ADR-102). The merge over the stored record happens in
// the handler under the row lock, so these cases assert what the form said, and
// that nothing here reads the mandate first — the read it used to do was a
// snapshot nobody locked, and two operators could each post a whole record back
// and restore a bound the other had lowered.
//
// **The other half of that: the patch is sparse.** The dialog prefills every
// limit field from the mandate the page read and carries each prefill back in a
// hidden field, so the cases below pin which fields a submission puts in the
// change and which it leaves out. A prefill sent back unchanged would be read by
// the handler as an explicit edit, and on a mandate another operator narrowed
// while the dialog was open, that edit restores a bound nobody entered — through
// the locked merge rather than around it. An untouched field is absent, a cleared
// field is absent, and a submission that changed only the validity window names
// no measure at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorityOutput,
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
 * `changeMandateLimits` makes exactly ONE kernel call: it sends the operator's
 * changes and the handler merges them over the stored record under the row lock
 * (ADR-102). The stub answers that write, or refuses it, so a test asserting the
 * call's input is asserting what the form said and nothing about a merge.
 */
/**
 * The kernel answers by capability, because a submission carrying a day now
 * reads the viewer's zone before it writes: the day on a date input is a day in
 * the zone this app draws dates in, not in UTC. `timezone` defaults to the
 * app's own default so a test that says nothing about zones gets the behaviour
 * a signed-in operator gets.
 */
function kernelAnswers(options: {
  write?: unknown;
  writeThrows?: Error;
  timezone?: string;
  preferencesThrows?: Error;
  /** What `get_mandate` answers: the stored kind a money edit is checked against. */
  mandate?: unknown;
  mandateThrows?: Error;
}) {
  invoke.mockImplementation((name: string) => {
    if (name === "get_mandate")
      return options.mandateThrows !== undefined
        ? Promise.reject(options.mandateThrows)
        : Promise.resolve(options.mandate ?? mandateGetOutput());
    if (name === "get_user_preferences") {
      return options.preferencesThrows !== undefined
        ? Promise.reject(options.preferencesThrows)
        : Promise.resolve({
            // The whole contract output: the kernel checks it, and a partial
            // answer fails the read, which is now a refusal, not a fallback.
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
    }
    if (options.writeThrows !== undefined)
      return Promise.reject(options.writeThrows);
    return Promise.resolve(options.write ?? mandateOutput());
  });
}

/** The one `update_mandate_limits` call's input. */
function written(): unknown {
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

/**
 * A dialog that prefilled nothing: the mandate held no counted measure and no
 * calls cap, so every value in the submission is one the operator typed and the
 * whole of it is a change.
 */
const NO_PREFILL = {
  measure: "",
  unit: "",
  period: "monthly" as const,
  perCall: "",
  perPeriod: "",
  callsPerDay: "",
};

/**
 * A dialog opened on a mandate bounded at 50 rows a call, 1000 rows a month and
 * 40 calls a day: what `measureDefaults` puts in the visible fields and what the
 * hidden fields beside them carry back.
 */
const PREFILLED = {
  measure: "rows",
  unit: "rows",
  period: "monthly" as const,
  perCall: "50",
  perPeriod: "1000",
  callsPerDay: "40",
};

/** That dialog submitted with nothing touched: every field still its prefill. */
const untouched = {
  mandateId: MANDATE_ID,
  ...PREFILLED,
  validTo: "",
  baseline: PREFILLED,
};

describe("changeMandateLimits", () => {
  /**
   * An operator typing a whole bound into a dialog that prefilled nothing, so
   * every field of this submission is a change and the whole of it is carried.
   */
  const draft = {
    mandateId: MANDATE_ID,
    measure: "rows",
    unit: "rows",
    perCall: "50",
    perPeriod: "1000",
    period: "monthly" as const,
    callsPerDay: "40",
    validTo: "2026-12-31",
    baseline: NO_PREFILL,
  };

  it("sends the changes the operator made, with the window's last day", async () => {
    kernelAnswers({});
    expect(
      await changeMandateLimits("a-intel", "core-platform", draft),
    ).toEqual({ ok: true, value: { mandateId: MANDATE_ID, status: "active" } });
    expect(requireViewer).toHaveBeenCalledWith("a-intel", "core-platform");
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: {
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
        // No period: the form shows the calls cap as a bare number and exposes
        // no period control, so the change says nothing about the window and
        // the handler keeps the stored one.
        calls: { perPeriod: "40", currencyOrUnit: "calls" },
      },
      // The last day runs through its end, so a window to 2026-12-31 expires
      // as that day ends rather than as it begins.
      // The end of the operator's 31 December in Pacific time, not in UTC.
      validTo: "2027-01-01T07:59:59.999Z",
    });
  });

  // The defect this exists for. The action used to read the mandate, merge the
  // edit over the stored record, and post the whole record back, and that read
  // was a snapshot nobody held a lock on: two operators editing different bounds
  // each sent a complete record, and the later write restored the bound the
  // earlier one had lowered. One call carries no snapshot to be stale.
  it("writes once and never reads the mandate", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", draft);
    expect(invoke).toHaveBeenCalledWith(
      "update_mandate_limits",
      expect.objectContaining({ mandateId: MANDATE_ID }),
      expect.objectContaining(TENANT),
    );
    // The mandate is what must not be read: that read was the stale snapshot.
    // The viewer's zone is not a snapshot of anything this write changes, and it
    // is only read when a day was submitted, as the case below shows.
    expect(
      invoke.mock.calls.filter(([name]) => name === "get_mandate"),
    ).toHaveLength(0);
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(1);
  });

  it("makes exactly one kernel call when no day was submitted", async () => {
    kernelAnswers({});
    // Nothing to place in a zone, so the preference is not read at all and a
    // limit-only change costs one call, as it did before zones came into it.
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      callsPerDay: "90",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { calls: { perPeriod: "90", currencyOrUnit: "calls" } },
    });
  });

  it("reads the viewer's zone and ends the day in it, not in UTC", async () => {
    kernelAnswers({ timezone: "Asia/Tokyo" });
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      validTo: "2027-01-31",
    });
    // The same day as the Pacific cases above, resolved in a different zone: the
    // instant differs, which is the whole point. Appending a fixed UTC time
    // would have produced one answer for every operator on earth.
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      validTo: "2027-01-31T14:59:59.999Z",
    });
  });

  // This used to fall back to Pacific, on the argument that a window disagreeing
  // with the dates beside it is worse than one in a zone the operator did not
  // choose. That is right for drawing a date and wrong for writing a boundary:
  // for an operator in Tokyo, Pacific moves the end of their day 17 hours later,
  // which is authority nobody granted, and nothing afterwards says it was
  // guessed. A refusal is visible and retryable; the widened window was neither.
  it("refuses a date change when the zone cannot be read (negative)", async () => {
    kernelAnswers({ preferencesThrows: new Error("preferences unreachable") });
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        validTo: "2027-01-31",
      }),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: "time_zone_unavailable",
    });
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  it("refuses a date change when the stored zone is one this runtime cannot read (negative)", async () => {
    // Retrying will not help this one, so it is a conflict rather than an
    // unavailability, and its sentence tells the person to pick a zone again.
    kernelAnswers({ timezone: "Mars/Olympus_Mons" });
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        validTo: "2027-01-31",
      }),
    ).toEqual({
      ok: false,
      reason: "conflict",
      code: "time_zone_unsupported",
    });
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  it("still writes a limit change when the zone cannot be read, since no day was picked", async () => {
    // The zone is only needed to place a day. A submission that names none is
    // not held up by a preference read it never makes.
    kernelAnswers({ preferencesThrows: new Error("preferences unreachable") });
    const result = await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      callsPerDay: "70",
    });
    expect(result).toEqual({
      ok: true,
      value: { mandateId: MANDATE_ID, status: "active" },
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { calls: { perPeriod: "70", currencyOrUnit: "calls" } },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // A blank box means "leave this bound as it is", which is what the dialog
  // says. The change carries no key for it, so nothing can read it as a
  // deletion, and a deleted sublimit is unbounded authority for that sublimit.
  it("leaves a field the operator cleared out of the change entirely", async () => {
    kernelAnswers({});
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
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: {
        recipients: {
          perPeriod: "400",
          period: "weekly",
          currencyOrUnit: "recipients",
        },
      },
    });
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
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: {
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
      },
    });
  });

  it("changes the window alone, with no limit change, when only a date is given", async () => {
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
      baseline: NO_PREFILL,
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      validTo: "2027-02-01T07:59:59.999Z",
    });
  });

  it("changes a calls cap on its own, naming no other measure", async () => {
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
      baseline: NO_PREFILL,
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      // Every other measure's bound is left to the handler, which keeps what it
      // is not told to change. Sending a whole record from here is what made a
      // concurrent edit able to restore a bound somebody lowered.
      limitChanges: { calls: { perPeriod: "500", currencyOrUnit: "calls" } },
    });
  });

  // The second half of the concurrency defect, and the one the atomic merge does
  // not cover. The dialog opened with 50 rows a call, 1000 a month and 40 calls a
  // day in its fields; the operator moved the validity date and touched nothing
  // else. Asserting those three figures would tell the handler to store the
  // record this dialog read, which on a mandate somebody narrowed in the meantime
  // is a bound nobody entered, written through the locked merge.
  it("sends no limit change at all when only the validity date moved", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      validTo: "2027-03-31",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      // March, so Pacific is on daylight time and the instant is an hour earlier.
      validTo: "2027-04-01T06:59:59.999Z",
    });
    // One write, and no read of the mandate: the zone read is the only other
    // call, and it is not a snapshot of any bound this write could restore.
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(1);
    expect(
      invoke.mock.calls.filter(([name]) => name === "get_mandate"),
    ).toHaveLength(0);
  });

  it("names only the calls measure when only the calls cap moved", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      callsPerDay: "20",
    });
    // No `rows` key: the count bound is the handler's to keep. Restating it here
    // is what would have put 1000 a month back over a colleague's lower figure.
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { calls: { perPeriod: "20", currencyOrUnit: "calls" } },
    });
  });

  // Sparse within the measure too, not only across measures: the bound's other
  // figure, its unit and its window are all still their prefills, so none of
  // them is in the change and the handler keeps each as stored.
  it("carries the one figure that moved, with exactly the digits typed", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      perPeriod: "800",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { rows: { perPeriod: "800" } },
    });
  });

  // A cleared field and an untouched field produce the same patch, and they mean
  // the same thing: leave the stored bound alone. Clearing is not deletion, which
  // the dialog's copy says and this pins — the two cases are written apart so a
  // change that started sending a cleared field as an edit fails one of them.
  it("leaves a field the operator cleared out of the change, as it leaves a prefill", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      perCall: "",
      perPeriod: "800",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { rows: { perPeriod: "800" } },
    });
  });

  it("changes a bound's window without restating its figures", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      period: "weekly",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { rows: { period: "weekly" } },
    });
  });

  // A different measure name is a different bound, one the record may not hold at
  // all, so nothing typed against it can be a prefill left over from the old one:
  // the figures, the unit and the window are all this operator's statement about
  // the new measure, and a bound with no figure or no unit would be refused by
  // the handler rather than stored.
  it("carries every field when the operator names a different measure", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...untouched,
      measure: "recipients",
      unit: "recipients",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: {
        recipients: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "recipients",
        },
      },
    });
  });

  // `update_mandate_limits` refuses a request that names no change, so a
  // submission holding only its prefills is refused here instead, naming a field
  // a person can act on. Reaching the kernel with an empty change would be a
  // schema failure that names none.
  it("refuses a submission that changed nothing (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", untouched),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "perPeriod",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  // A limit denominated in an ISO 4217 code reads back as money while the figure
  // beside it is whole units: the one shape this form cannot write correctly.
  // The record holds `amount` as money and nothing named `rows`, so a currency
  // on `rows` has no stored kind to scale by. It is refused, in either casing,
  // and the read that established it is the only call made.
  it("refuses a currency unit on a measure the record does not hold as money, and writes nothing (negative)", async () => {
    kernelAnswers({});
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
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
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
        baseline: NO_PREFILL,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "perPeriod",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  // Validation runs on every value the form carries, not only on the ones that
  // differ from their prefill. A server action is reachable by anyone holding a
  // session, so "the dialog would not have prefilled that" is not a check; and a
  // bound the form cannot write correctly has to stop the submission rather than
  // be quietly left out of the change and sent anyway.
  it("refuses a unit the form cannot write even when it equals the prefill (negative)", async () => {
    kernelAnswers({});
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...untouched,
        unit: "USD",
        baseline: { ...PREFILLED, unit: "USD" },
        callsPerDay: "20",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "unit",
    });
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  // A shape check accepted this and `endOfZonedDay` rolled it to 3 March, so a
  // day that does not exist was worth three extra days of authority. The check is
  // `isCalendarDay`, shared with the audit filters, which already had it.
  it("refuses a day-shaped value that is not a day (negative)", async () => {
    for (const validTo of ["2027-02-31", "2027-02-29", "2026-99-99"]) {
      invoke.mockClear();
      expect(
        await changeMandateLimits("a-intel", "core-platform", {
          ...untouched,
          validTo,
        }),
      ).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "validTo",
      });
      expect(invoke).not.toHaveBeenCalled();
    }
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
    expect(
      await changeMandateLimits("a-intel", "core-platform", draft),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });

  it("reports a mandate nobody recorded as not found (negative)", async () => {
    kernelAnswers({
      writeThrows: new kernel.HandlerError({
        code: "not_found",
        reason: "mandate_not_found",
        message: "no such mandate",
      }),
    });
    expect(
      await changeMandateLimits("a-intel", "core-platform", draft),
    ).toEqual({ ok: false, reason: "not_found", code: "mandate_not_found" });
  });

  it("reports an IAM denial as a denial (negative)", async () => {
    kernelAnswers({ writeThrows: denied("update_mandate_limits") });
    expect(
      await changeMandateLimits("a-intel", "core-platform", draft),
    ).toEqual({ ok: false, reason: "denied", code: "authz_denied" });
  });

  it("reports a mandate that has already ended as a conflict (negative)", async () => {
    kernelAnswers({
      writeThrows: new kernel.HandlerError({
        code: "conflict",
        reason: "mandate_ended",
        message: "already revoked",
      }),
    });
    expect(
      await changeMandateLimits("a-intel", "core-platform", draft),
    ).toEqual({ ok: false, reason: "conflict", code: "mandate_ended" });
  });
});

/**
 * A dialog opened on the fixture mandate's money limit: `amount` in USD at
 * $250 a call and $2,000 a month, which the record holds as micros with the
 * kind the handler stamped (ADR-108).
 */
const MONEY = {
  measure: "amount",
  unit: "USD",
  period: "monthly" as const,
  perCall: "250",
  perPeriod: "2000",
  callsPerDay: "",
};
const moneyUntouched = {
  mandateId: MANDATE_ID,
  ...MONEY,
  validTo: "",
  baseline: MONEY,
};

describe("changeMandateLimits on a money limit (ADR-108)", () => {
  it("scales a typed amount to micros by the stored kind, and sends only the figure that moved", async () => {
    kernelAnswers({});
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...moneyUntouched,
        perPeriod: "1500.50",
      }),
    ).toEqual({ ok: true, value: { mandateId: MANDATE_ID, status: "active" } });
    // $1,500.50 is 1,500,500,000 micros. The currency is the stored one and is
    // not restated; the per-call bound was an echo and stays out.
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { amount: { perPeriod: "1500500000" } },
    });
    // One read for the stored kind, then the one write. The read's record is
    // not merged into the write.
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "get_mandate",
      "update_mandate_limits",
    ]);
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      mandateId: MANDATE_ID,
      ledgerLimit: 1,
    });
  });

  it("reads 2000.00 against a prefill of 2000 as the same micros, not an edit", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...moneyUntouched,
      perCall: "250.00",
      perPeriod: "2000.000000",
      unit: "usd",
      callsPerDay: "30",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      limitChanges: { calls: { perPeriod: "30", currencyOrUnit: "calls" } },
    });
  });

  // ADR-108's case: a tool may declare a count denominated in a currency code.
  // The record then holds `amount` as a count, and a figure typed against it
  // must not be multiplied by a million because its unit is spelled USD.
  it("refuses to scale a figure the record holds as a count under a currency code (negative)", async () => {
    kernelAnswers({
      mandate: mandateGetOutput(
        [],
        mandateOutput({
          authority: [
            authorityOutput({
              kind: "count",
              perCall: "250",
              perPeriod: "2000",
              settled: "0",
              reserved: "0",
              remaining: "2000",
            }),
          ],
        }),
      ),
    });
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...moneyUntouched,
        perPeriod: "1500",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "unit",
    });
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  it("refuses a currency other than the one the record holds (negative)", async () => {
    kernelAnswers({});
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...moneyUntouched,
        measure: "fees",
        unit: "EUR",
        perPeriod: "10",
        baseline: { ...MONEY, measure: "fees", unit: "EUR" },
        callsPerDay: "",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "unit",
    });
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  it("refuses a change of the limit's currency before the kernel runs (negative)", async () => {
    expect(
      await changeMandateLimits("a-intel", "core-platform", {
        ...moneyUntouched,
        unit: "EUR",
        perPeriod: "1800",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "unit",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["12.0000001", "1,500", "-5", "1e3"])(
    "refuses %j as an amount before the kernel runs (negative)",
    async (typed) => {
      expect(
        await changeMandateLimits("a-intel", "core-platform", {
          ...moneyUntouched,
          perPeriod: typed,
        }),
      ).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "perPeriod",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("writes nothing when the mandate read is refused, and says why (negative)", async () => {
    kernelAnswers({ mandateThrows: denied("get_mandate") });
    const result = await changeMandateLimits("a-intel", "core-platform", {
      ...moneyUntouched,
      perPeriod: "1500",
    });
    expect(result).toMatchObject({ ok: false, reason: "denied" });
    expect(
      invoke.mock.calls.filter(([name]) => name === "update_mandate_limits"),
    ).toHaveLength(0);
  });

  it("changes only the window on a money mandate, reading the kind but sending no limit", async () => {
    kernelAnswers({});
    await changeMandateLimits("a-intel", "core-platform", {
      ...moneyUntouched,
      validTo: "2027-01-31",
    });
    expect(written()).toEqual({
      mandateId: MANDATE_ID,
      validTo: "2027-02-01T07:59:59.999Z",
    });
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
