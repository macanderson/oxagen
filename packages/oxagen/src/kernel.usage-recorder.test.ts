/**
 * Unit tests for the governed-action usage recorder in the kernel (ADR-052).
 *
 * This is the accrual half of the meter, and it is the half a customer sees on
 * an invoice. The four exclusions ADR-052 builds into WHERE the recorder fires
 * — nested invokes, `noBillingGate` contracts, denials, and failures — are not
 * policy layered on afterwards; they are the position of one call site. That
 * makes them easy to break with a refactor that looks harmless, and expensive
 * to break: each one is a way to charge for something that did not happen, or
 * to charge for it more than once.
 *
 * The most important test in this file is the nested one. An invoice that
 * depends on Oxagen's internal call graph is an invoice the customer cannot
 * check and that moves between releases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  clearBillingAdmissionGate,
  clearHandlersForTests,
  clearSecurityEventEmitter,
  clearUsageRecorder,
  governedActionUnits,
  invoke,
  registerHandler,
  setUsageRecorder,
  type GovernedActionRecord,
} from "./kernel";

const ORG = "00000000-0000-0000-0000-000000000001";
const WS = "00000000-0000-0000-0000-000000000002";

const ctx: CapabilityContext = {
  orgId: ORG,
  workspaceId: WS,
  userId: "u",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

type CapOverrides = {
  name: string;
  noBillingGate?: boolean;
  scoped?: boolean;
  meter?: { unitsFrom: string; unitsPerAction: number };
};

const defineCap = (over: CapOverrides) =>
  registerCapability({
    domain: "test",
    description: "Accrual fixture.",
    mode: "sync" as const,
    surfaces: ["api"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    scoped: false,
    input: z.object({}).passthrough(),
    output: z.object({}).passthrough(),
    ...over,
  } as Parameters<typeof registerCapability>[0]);

describe("kernel governed-action usage recorder", () => {
  let recorded: GovernedActionRecord[];
  let recorder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearBillingAdmissionGate();
    clearSecurityEventEmitter();
    recorded = [];
    recorder = vi.fn((r: GovernedActionRecord) => {
      recorded.push(r);
    });
    setUsageRecorder(recorder as unknown as (r: GovernedActionRecord) => void);
  });

  afterEach(() => {
    clearUsageRecorder();
    vi.restoreAllMocks();
  });

  // ── The happy path ────────────────────────────────────────────────────────

  it("records exactly one action for one successful top-level invocation", async () => {
    defineCap({ name: "accrual_ok" });
    registerHandler("accrual_ok", async () => async () => ({ ok: true }));

    await invoke("accrual_ok", {}, ctx, { surface: "api" });

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorded[0]?.actions).toBe(1);
    expect(recorded[0]?.capability).toBe("accrual_ok");
    expect(recorded[0]?.orgId).toBe(ORG);
  });

  it("carries the attribution an invoice needs to be grouped and checked", async () => {
    defineCap({ name: "accrual_attr" });
    registerHandler("accrual_attr", async () => async () => ({ ok: true }));

    await invoke(
      "accrual_attr",
      {},
      { ...ctx, executionStepId: "run-7" } as CapabilityContext,
      { surface: "api" },
    );

    const r = recorded[0];
    expect(r?.workspaceId).toBe(WS);
    expect(r?.surface).toBe("api");
    expect(r?.requestId).toBe("req-1");
    // The run is metadata for grouping, never a billing unit (spec §3.3).
    expect(r?.runId).toBe("run-7");
    expect(r?.occurredAt).toBeInstanceOf(Date);
  });

  it("reports a null run rather than inventing one when the caller supplied none", async () => {
    defineCap({ name: "accrual_norun" });
    registerHandler("accrual_norun", async () => async () => ({ ok: true }));

    await invoke("accrual_norun", {}, ctx, { surface: "api" });

    // A fabricated id would group a charge under a run that did not happen.
    expect(recorded[0]?.runId).toBeNull();
  });

  // ── Exclusion 1: nesting. The one that protects the invoice. ──────────────

  it("bills a nested call tree ONCE, at the outermost invoke", async () => {
    defineCap({ name: "accrual_outer" });
    defineCap({ name: "accrual_inner" });
    registerHandler("accrual_inner", async () => async () => ({ inner: true }));
    registerHandler("accrual_outer", async () => async () => {
      await invoke("accrual_inner", {}, ctx, { surface: "api" });
      await invoke("accrual_inner", {}, ctx, { surface: "api" });
      return { outer: true };
    });

    await invoke("accrual_outer", {}, ctx, { surface: "api" });

    // Three invocations happened; one governed action is sold. Oxagen's own
    // call graph is an implementation detail that moves between releases, and
    // a customer cannot see it to check a bill against it.
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorded[0]?.capability).toBe("accrual_outer");
  });

  it("bills two sequential top-level calls twice — nesting is per call tree, not per process", async () => {
    defineCap({ name: "accrual_seq" });
    registerHandler("accrual_seq", async () => async () => ({ ok: true }));

    await invoke("accrual_seq", {}, ctx, { surface: "api" });
    await invoke("accrual_seq", {}, ctx, { surface: "api" });

    expect(recorder).toHaveBeenCalledTimes(2);
  });

  it("treats an UNSCOPED capability's nesting correctly", async () => {
    // The dedicated ALS frame exists precisely for this: an unscoped
    // capability never enters a tenant scope, so reading nesting off the
    // tenant scope would have reported this inner call as top-level and
    // charged the customer twice for one action.
    defineCap({ name: "accrual_unscoped_outer" });
    defineCap({ name: "accrual_unscoped_inner" });
    registerHandler(
      "accrual_unscoped_inner",
      async () => async () => ({ inner: true }),
    );
    registerHandler("accrual_unscoped_outer", async () => async () => {
      await invoke("accrual_unscoped_inner", {}, ctx, { surface: "api" });
      return { outer: true };
    });

    await invoke("accrual_unscoped_outer", {}, ctx, { surface: "api" });

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorded[0]?.capability).toBe("accrual_unscoped_outer");
  });

  // ── Exclusion 2: noBillingGate ────────────────────────────────────────────

  it("never bills a noBillingGate capability — reading your own spend is not a charge", async () => {
    defineCap({ name: "accrual_free", noBillingGate: true });
    registerHandler("accrual_free", async () => async () => ({ ok: true }));

    await invoke("accrual_free", {}, ctx, { surface: "api" });

    expect(recorder).not.toHaveBeenCalled();
  });

  // ── Exclusions 3 and 4: denials and failures ──────────────────────────────

  it("never bills a handler that threw — there is no completed action to sell", async () => {
    defineCap({ name: "accrual_throws" });
    registerHandler("accrual_throws", async () => async () => {
      throw new Error("handler exploded");
    });

    await expect(
      invoke("accrual_throws", {}, ctx, { surface: "api" }),
    ).rejects.toThrow();
    expect(recorder).not.toHaveBeenCalled();
  });

  it("never bills an invocation whose output failed its contract", async () => {
    registerCapability({
      name: "accrual_bad_output",
      domain: "test",
      description: "Returns output that does not match its contract.",
      mode: "sync" as const,
      surfaces: ["api"] as const,
      layers: ["unit"] as const,
      sensitivity: "low" as const,
      defaultEffect: "allow" as const,
      defaultRoles: { org: {}, workspace: {} },
      scoped: false,
      input: z.object({}),
      output: z.object({ required: z.string() }),
    });
    registerHandler(
      "accrual_bad_output",
      async () => async () => ({ wrong: true }) as never,
    );

    await expect(
      invoke("accrual_bad_output", {}, ctx, { surface: "api" }),
    ).rejects.toThrow();
    expect(recorder).not.toHaveBeenCalled();
  });

  it("never bills an invocation denied at the billing admission gate", async () => {
    // Scoped, because the kernel skips the billing admission gate entirely for
    // an unscoped capability — there is no organisation to admit. The ids in
    // `ctx` are real uuids, so runInTenantScope is satisfied without a DB.
    defineCap({ name: "accrual_denied", scoped: true });
    registerHandler("accrual_denied", async () => async () => ({ ok: true }));
    const { setBillingAdmissionGate } = await import("./kernel");
    setBillingAdmissionGate(async () => {
      throw new Error("insufficient credits");
    });

    await expect(
      invoke("accrual_denied", {}, ctx, { surface: "api" }),
    ).rejects.toThrow();
    // Billing a denial would pay Oxagen more when a customer's policy is
    // stricter, which is the incentive ADR-052 refuses to create.
    expect(recorder).not.toHaveBeenCalled();
  });

  it("does not bill when there is no organisation to bill", async () => {
    defineCap({ name: "accrual_no_org" });
    registerHandler("accrual_no_org", async () => async () => ({ ok: true }));

    await invoke("accrual_no_org", {}, { ...ctx, orgId: "" }, {
      surface: "api",
    });

    expect(recorder).not.toHaveBeenCalled();
  });

  // ── Failure isolation ─────────────────────────────────────────────────────

  it("returns the handler's result even when accrual throws", async () => {
    // The action happened and the customer's response is already correct.
    // Failing now would trade a missed charge for a broken request.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    defineCap({ name: "accrual_recorder_throws" });
    registerHandler(
      "accrual_recorder_throws",
      async () => async () => ({ ok: true }),
    );
    clearUsageRecorder();
    setUsageRecorder(() => {
      throw new Error("ledger is down");
    });

    const out = await invoke("accrual_recorder_throws", {}, ctx, {
      surface: "api",
    });

    expect(out).toEqual({ ok: true });
    // Loud, because a silent one is a revenue leak.
    expect(err).toHaveBeenCalled();
  });

  it("proceeds with no accrual at all when no recorder is registered", async () => {
    clearUsageRecorder();
    defineCap({ name: "accrual_none" });
    registerHandler("accrual_none", async () => async () => ({ ok: true }));

    await expect(
      invoke("accrual_none", {}, ctx, { surface: "api" }),
    ).resolves.toEqual({ ok: true });
  });
});

// ── governedActionUnits: the multi-unit case ────────────────────────────────
//
// A bulk write that reports nothing is still one governed action — it passed
// the gates and left a record — so the floor is 1 and never 0. Every input
// that is not a usable positive count falls back to that floor rather than
// throwing, because this runs after the action succeeded.

describe("governedActionUnits", () => {
  it("is one action when the contract declares no meter", () => {
    expect(governedActionUnits(undefined, { rows: 5000 })).toBe(1);
  });

  it("divides the reported unit count by the units-per-action, rounding up", () => {
    const meter = { unitsFrom: "rows", unitsPerAction: 100 };
    expect(governedActionUnits(meter, { rows: 100 })).toBe(1);
    expect(governedActionUnits(meter, { rows: 101 })).toBe(2);
    expect(governedActionUnits(meter, { rows: 1000 })).toBe(10);
  });

  it("floors at one action for a zero, negative, missing or non-numeric count", () => {
    const meter = { unitsFrom: "rows", unitsPerAction: 100 };
    for (const output of [
      { rows: 0 },
      { rows: -5 },
      { rows: Number.NaN },
      { rows: Number.POSITIVE_INFINITY },
      { rows: "many" },
      { other: 500 },
      null,
      "not an object",
    ]) {
      expect(governedActionUnits(meter, output)).toBe(1);
    }
  });

  it("falls back to one action when the meter's divisor is unusable", () => {
    // A zero or negative divisor would make the charge infinite or negative.
    for (const unitsPerAction of [0, -1, Number.NaN, 0.5]) {
      expect(
        governedActionUnits({ unitsFrom: "rows", unitsPerAction }, { rows: 500 }),
      ).toBe(1);
    }
  });
});
