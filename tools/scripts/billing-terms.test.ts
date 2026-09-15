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
 */
import { describe, expect, it, vi } from "vitest";
import { isKernelIssuedPlatformOperator } from "@oxagen/oxagen/platform-operator";
import type { CapabilityContext } from "@oxagen/oxagen";
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

/** A fake kernel that records what it was called with and echoes the input. */
function fakeInvoke() {
  const calls: {
    name: string;
    input: unknown;
    ctx: CapabilityContext;
  }[] = [];
  const fn = vi.fn(
    async (name: string, input: unknown, ctx: CapabilityContext) => {
      calls.push({ name, input, ctx });
      return input;
    },
  );
  return { calls, fn };
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
  ])("refuses a missing flag: %j", (argv, message) => {
    expect(() => parseFlags(argv)).toThrow(message);
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

    const stored = await runBillingTerms(flags, {
      resolveOrgId: async () => ORG_ID,
      invoke: kernel.fn,
      requestId: "req-1",
    });

    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0].name).toBe("set_org_billing_terms");
    expect(kernel.calls[0].input).toEqual({
      orgId: ORG_ID,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });
    expect(stored).toEqual({
      orgId: ORG_ID,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });
  });

  it("looks the org up by the slug the operator typed", async () => {
    const kernel = fakeInvoke();
    const resolveOrgId = vi.fn(async () => ORG_ID);

    await runBillingTerms(flags, { resolveOrgId, invoke: kernel.fn });

    expect(resolveOrgId).toHaveBeenCalledWith("acme");
  });

  it("carries a kernel-minted platform-operator binding on the context", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, {
      resolveOrgId: async () => ORG_ID,
      invoke: kernel.fn,
      requestId: "req-2",
    });

    const ctx = kernel.calls[0].ctx;
    expect(isKernelIssuedPlatformOperator(ctx.platformOperator)).toBe(true);
    expect(ctx.platformOperator?.requestId).toBe("req-2");
  });

  it("names the runner surface on the context and no tenant", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, {
      resolveOrgId: async () => ORG_ID,
      invoke: kernel.fn,
      requestId: "req-3",
    });

    const ctx = kernel.calls[0].ctx;
    expect(ctx.surface).toBe("runner");
    expect(ctx.requestId).toBe("req-3");
    expect(ctx.orgId).toBe("");
    expect(ctx.workspaceId).toBe("");
    expect(ctx.userId).toBeNull();
  });

  it("passes no opts argument, which surfaces: [] would refuse", async () => {
    const kernel = fakeInvoke();

    await runBillingTerms(flags, {
      resolveOrgId: async () => ORG_ID,
      invoke: kernel.fn,
    });

    expect(kernel.fn.mock.calls[0]).toHaveLength(3);
  });

  it("refuses an unknown slug before invoking anything", async () => {
    const kernel = fakeInvoke();

    await expect(
      runBillingTerms(flags, {
        resolveOrgId: async () => null,
        invoke: kernel.fn,
      }),
    ).rejects.toThrow(/no organisation with slug "acme"/);
    expect(kernel.fn).not.toHaveBeenCalled();
  });

  it("refuses an output the contract does not describe", async () => {
    await expect(
      runBillingTerms(flags, {
        resolveOrgId: async () => ORG_ID,
        invoke: async () => ({ orgId: ORG_ID }),
      }),
    ).rejects.toThrow();
  });

  it("mints a distinct binding per run", async () => {
    const kernel = fakeInvoke();
    const deps = { resolveOrgId: async () => ORG_ID, invoke: kernel.fn };

    await runBillingTerms(flags, deps);
    await runBillingTerms(flags, deps);

    expect(kernel.calls[0].ctx.platformOperator).not.toBe(
      kernel.calls[1].ctx.platformOperator,
    );
    expect(kernel.calls[0].ctx.requestId).not.toBe(
      kernel.calls[1].ctx.requestId,
    );
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
