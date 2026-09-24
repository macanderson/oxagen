/**
 * Unit tests for billing-terms — the platform operator's only path to
 * `set_org_billing_terms`.
 *
 * The run is exercised against a fake `invoke`, so what is asserted is what
 * the kernel would actually receive: the capability name, the resolved org id
 * on the INPUT (never the slug), and a context carrying a kernel-minted
 * platform-operator binding with `surface: "runner"` and no tenant. The kernel
 * side of that bargain — refusing the call without the binding — is asserted
 * in packages/oxagen/src/kernel.test.ts.
 *
 * The audit half is asserted against fakes of the kernel's emitter hook and
 * the row inserter: the emitter is registered before the invoke, the row the
 * kernel's event becomes names the target org, and the run does not settle
 * until that row's insert has.
 */
import { describe, expect, it, vi } from "vitest";
import { isKernelIssuedPlatformOperator } from "@oxagen/oxagen/platform-operator";
import type { KernelSecurityEvent } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { SecurityEventInput } from "@oxagen/telemetry";
import {
  describeTarget,
  parseFlags,
  runBillingTerms,
  type BillingTermsFlags,
} from "./billing-terms";

const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";

const flags: BillingTermsFlags = {
  orgSlug: "acme",
  approvedForInvoiceBilling: true,
  invoiceGauMax: 250_000,
};

/** The kernel event a fake invoke emits for the call it received. */
function kernelEvent(
  ctx: CapabilityContext,
  outcome: KernelSecurityEvent["outcome"],
): KernelSecurityEvent {
  return {
    capability: "set_org_billing_terms",
    outcome,
    surface: ctx.surface,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    errorCode: outcome === "allow" ? null : "authz_denied",
    durationMs: 1,
  };
}

/**
 * A fake kernel: records what it was called with, emits one security event
 * through whatever emitter the run registered (as the real kernel does, right
 * before it returns or throws), and echoes the input. The audit fakes record
 * every row and let a test hold the insert open.
 */
function fakeInvoke(opts: { outcome?: KernelSecurityEvent["outcome"] } = {}) {
  const outcome = opts.outcome ?? "allow";
  const calls: {
    name: string;
    input: unknown;
    ctx: CapabilityContext;
    emitterRegistered: boolean;
  }[] = [];
  let emitter: ((event: KernelSecurityEvent) => void) | null = null;
  const rows: SecurityEventInput[] = [];
  const pending: (() => void)[] = [];
  const fn = vi.fn(
    async (name: string, input: unknown, ctx: CapabilityContext) => {
      calls.push({ name, input, ctx, emitterRegistered: emitter !== null });
      emitter?.(kernelEvent(ctx, outcome));
      if (outcome !== "allow") throw new Error("authz_denied");
      // The stored row after the call: what the input set, over the column
      // defaults for what it left alone.
      return {
        approvedForInvoiceBilling: false,
        invoiceGauMax: 100_000,
        assistantSpendCapCents: 2_000,
        ...(input as Record<string, unknown>),
      };
    },
  );
  return {
    calls,
    fn,
    rows,
    setSecurityEventEmitter: vi.fn(
      (e: (event: KernelSecurityEvent) => void) => {
        emitter = e;
      },
    ),
    recordSecurityEvent: vi.fn(
      (row: SecurityEventInput) =>
        new Promise<void>((resolve) => {
          rows.push(row);
          pending.push(resolve);
        }),
    ),
    /** Settle every held insert. */
    releaseAudits: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

/** The deps a run needs, with every audit insert released as it arrives. */
function depsOf(
  kernel: ReturnType<typeof fakeInvoke>,
  overrides: {
    resolveOrgId?: () => Promise<string | null>;
    requestId?: string;
  } = {},
) {
  return {
    resolveOrgId: overrides.resolveOrgId ?? (async () => ORG_ID),
    invoke: kernel.fn,
    setSecurityEventEmitter: kernel.setSecurityEventEmitter,
    recordSecurityEvent: vi.fn(async (row: SecurityEventInput) => {
      const held = kernel.recordSecurityEvent(row);
      kernel.releaseAudits();
      await held;
    }),
    ...(overrides.requestId === undefined
      ? {}
      : { requestId: overrides.requestId }),
  };
}

/**
 * The recorded call at `index`, or a thrown failure naming the gap.
 *
 * `noUncheckedIndexedAccess` (tsconfig.base.json) types an indexed read as
 * possibly undefined, so reading `.ctx` off `calls[0]` does not compile. A
 * throw here also reports the right thing when a call is genuinely missing:
 * "expected a kernel call at index 1" rather than a property access on
 * undefined several lines later.
 */
function callAt(kernel: ReturnType<typeof fakeInvoke>, index: number) {
  const call = kernel.calls[index];
  if (!call) {
    throw new Error(
      `expected a kernel call at index ${index}; the fake recorded ${kernel.calls.length}`,
    );
  }
  return call;
}

describe("parseFlags", () => {
  it("reads the three flags in any order", () => {
    expect(
      parseFlags([
        "--invoice-gau-max",
        "250000",
        "--org",
        "acme",
        "--invoice-billing",
        "on",
      ]),
    ).toEqual(flags);
  });

  it("maps --invoice-billing off to false", () => {
    expect(
      parseFlags([
        "--org",
        "acme",
        "--invoice-billing",
        "off",
        "--invoice-gau-max",
        "1",
      ]).approvedForInvoiceBilling,
    ).toBe(false);
  });

  it.each([
    [
      ["--invoice-billing", "on", "--invoice-gau-max", "1"],
      /--org is required/,
    ],
    [["--org", "acme", "--invoice-gau-max", "1"], /--invoice-billing/],
    [["--org", "acme", "--invoice-billing", "on"], /--invoice-gau-max/],
    [["--org", "acme"], /nothing to set/],
  ])("refuses a missing flag: %j", (argv, message) => {
    expect(() => parseFlags(argv)).toThrow(message);
  });

  it("reads the assistant cap in dollars, alone or beside the mode", () => {
    expect(
      parseFlags(["--org", "acme", "--assistant-cap-usd", "6000"]),
    ).toEqual({
      orgSlug: "acme",
      assistantSpendCapCents: 600_000,
    });
    expect(
      parseFlags(["--org", "acme", "--assistant-cap-usd", "12.50"]),
    ).toEqual({
      orgSlug: "acme",
      assistantSpendCapCents: 1_250,
    });
    expect(
      parseFlags([
        "--org",
        "acme",
        "--invoice-billing",
        "on",
        "--invoice-gau-max",
        "250000",
        "--assistant-cap-usd",
        "none",
      ]),
    ).toEqual({ ...flags, assistantSpendCapCents: null });
  });

  it.each(["-5", "1.005", "lots"])("refuses an assistant cap of %s", (raw) => {
    expect(() =>
      parseFlags(["--org", "acme", "--assistant-cap-usd", raw]),
    ).toThrow(/--assistant-cap-usd/);
  });

  it("refuses a value that is not on or off", () => {
    expect(() =>
      parseFlags([
        "--org",
        "acme",
        "--invoice-billing",
        "yes",
        "--invoice-gau-max",
        "1",
      ]),
    ).toThrow(/must be "on" or "off"/);
  });

  it.each(["0", "-5", "1.5", "lots"])(
    "refuses an invoice-gau-max of %s",
    (raw) => {
      expect(() =>
        parseFlags([
          "--org",
          "acme",
          "--invoice-billing",
          "on",
          "--invoice-gau-max",
          raw,
        ]),
      ).toThrow(/whole number/);
    },
  );

  it("refuses an unknown flag rather than ignoring it", () => {
    expect(() =>
      parseFlags([
        "--org",
        "acme",
        "--invoice-billing",
        "on",
        "--invoice-gau-max",
        "1",
        "--apply",
      ]),
    ).toThrow(/unknown flag: --apply/);
  });

  it("refuses a flag whose value is the next flag", () => {
    expect(() => parseFlags(["--org", "--invoice-billing", "on"])).toThrow(
      /--org needs a value/,
    );
  });
});

describe("runBillingTerms", () => {
  it("invokes set_org_billing_terms with the resolved org id and the flags", async () => {
    const kernel = fakeInvoke();

    const stored = await runBillingTerms(
      flags,
      depsOf(kernel, { requestId: "req-1" }),
    );

    expect(kernel.calls).toHaveLength(1);
    expect(callAt(kernel, 0).name).toBe("set_org_billing_terms");
    expect(callAt(kernel, 0).input).toEqual({
      orgId: ORG_ID,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });
    expect(stored).toEqual({
      orgId: ORG_ID,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
      assistantSpendCapCents: 2_000,
    });
  });

  it("sends only the cap when the run sets only the cap", async () => {
    const kernel = fakeInvoke();

    const stored = await runBillingTerms(
      { orgSlug: "acme", assistantSpendCapCents: 600_000 },
      depsOf(kernel),
    );

    expect(callAt(kernel, 0).input).toEqual({
      orgId: ORG_ID,
      assistantSpendCapCents: 600_000,
    });
    expect(stored.assistantSpendCapCents).toBe(600_000);
  });

  it("sends a removed cap as null beside the mode", async () => {
    const kernel = fakeInvoke();
    await runBillingTerms(
      { ...flags, assistantSpendCapCents: null },
      depsOf(kernel),
    );
    expect(callAt(kernel, 0).input).toEqual({
      orgId: ORG_ID,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
      assistantSpendCapCents: null,
    });
  });

  it("looks the org up by the slug the operator typed", async () => {
    const kernel = fakeInvoke();
    const resolveOrgId = vi.fn(async () => ORG_ID);

    await runBillingTerms(flags, depsOf(kernel, { resolveOrgId }));

    expect(resolveOrgId).toHaveBeenCalledWith("acme");
  });

  it("carries a kernel-minted platform-operator binding on the context", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, depsOf(kernel, { requestId: "req-2" }));

    const ctx = callAt(kernel, 0).ctx;
    expect(isKernelIssuedPlatformOperator(ctx.platformOperator)).toBe(true);
    expect(ctx.platformOperator?.requestId).toBe("req-2");
  });

  it("names the runner surface on the context and no tenant", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, depsOf(kernel, { requestId: "req-3" }));

    const ctx = callAt(kernel, 0).ctx;
    expect(ctx.surface).toBe("runner");
    expect(ctx.requestId).toBe("req-3");
    expect(ctx.orgId).toBe("");
    expect(ctx.workspaceId).toBe("");
    expect(ctx.userId).toBeNull();
  });

  it("passes no opts argument, which surfaces: [] would refuse", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, depsOf(kernel));

    expect(kernel.fn.mock.calls[0]).toHaveLength(3);
  });

  it("refuses an unknown slug before invoking anything", async () => {
    const kernel = fakeInvoke();

    await expect(
      runBillingTerms(
        flags,
        depsOf(kernel, { resolveOrgId: async () => null }),
      ),
    ).rejects.toThrow(/no organisation with slug "acme"/);
    expect(kernel.fn).not.toHaveBeenCalled();
    expect(kernel.setSecurityEventEmitter).not.toHaveBeenCalled();
  });

  it("refuses an output the contract does not describe", async () => {
    const kernel = fakeInvoke();
    await expect(
      runBillingTerms(flags, {
        ...depsOf(kernel),
        invoke: async () => ({ orgId: ORG_ID }),
      }),
    ).rejects.toThrow();
  });

  it("mints a distinct binding per run", async () => {
    const kernel = fakeInvoke();
    const deps = depsOf(kernel);

    await runBillingTerms(flags, deps);
    await runBillingTerms(flags, deps);

    expect(callAt(kernel, 0).ctx.platformOperator).not.toBe(
      callAt(kernel, 1).ctx.platformOperator,
    );
    expect(callAt(kernel, 0).ctx.requestId).not.toBe(
      callAt(kernel, 1).ctx.requestId,
    );
  });
});

describe("runBillingTerms — the kernel audit row", () => {
  it("registers the kernel emitter before the invoke", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, depsOf(kernel));

    expect(kernel.setSecurityEventEmitter).toHaveBeenCalledOnce();
    expect(callAt(kernel, 0).emitterRegistered).toBe(true);
  });

  it("writes the allow row against the target org, with no tenant on the row", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, depsOf(kernel, { requestId: "req-4" }));

    expect(kernel.rows).toEqual([
      {
        eventType: "capability.invoke_allowed",
        actorUserId: null,
        orgId: ORG_ID,
        workspaceId: null,
        capability: "set_org_billing_terms",
        outcome: "allow",
        ip: null,
        userAgent: null,
        requestId: "req-4",
      },
    ]);
  });

  it("does not settle until the row's insert has", async () => {
    const kernel = fakeInvoke();
    let settled = false;
    const run = runBillingTerms(flags, {
      ...depsOf(kernel),
      recordSecurityEvent: kernel.recordSecurityEvent,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(kernel.fn).toHaveBeenCalledOnce();
    expect(kernel.rows).toHaveLength(1);
    expect(settled).toBe(false);

    kernel.releaseAudits();
    await run;
    expect(settled).toBe(true);
  });

  it("writes and awaits the deny row when the kernel refuses the call", async () => {
    const kernel = fakeInvoke({ outcome: "deny" });
    const deps = depsOf(kernel);

    await expect(runBillingTerms(flags, deps)).rejects.toThrow(/authz_denied/);

    expect(kernel.rows).toEqual([
      expect.objectContaining({
        eventType: "capability.invoke_denied",
        outcome: "deny",
        orgId: ORG_ID,
      }),
    ]);
    expect(deps.recordSecurityEvent).toHaveBeenCalledOnce();
  });

  it("fails the run when the row cannot be written", async () => {
    const kernel = fakeInvoke();

    await expect(
      runBillingTerms(flags, {
        ...depsOf(kernel),
        recordSecurityEvent: async () => {
          throw new Error("security_events insert failed after 3 attempts");
        },
      }),
    ).rejects.toThrow(/security_events insert failed/);
  });
});

describe("describeTarget", () => {
  it("prints host, port and database with the credentials stripped", () => {
    expect(
      describeTarget("postgres://oxagen:secret@db.internal:5433/oxagen"),
    ).toBe("db.internal:5433/oxagen");
  });

  it("defaults the port when the URL omits it", () => {
    expect(describeTarget("postgres://u:p@db.internal/oxagen")).toBe(
      "db.internal:5432/oxagen",
    );
  });

  it("says so rather than throwing when the URL will not parse", () => {
    expect(describeTarget("not-a-url")).toBe("(unparseable DATABASE_URL)");
  });
});
