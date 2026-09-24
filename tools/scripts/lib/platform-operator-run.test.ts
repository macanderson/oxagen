/**
 * Unit tests for platform-operator-run.ts: the flag readers an operator types
 * figures through, and the one invoke path the billing operator scripts take.
 *
 * The invoke is exercised against a fake kernel, so what is asserted is what
 * the kernel would receive (a context with a kernel-minted binding, the runner
 * surface, no tenant, no opts) and that every audit row the kernel emits is
 * awaited, deny path included. The kernel's refusal without a binding is
 * asserted in packages/oxagen/src/kernel.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { isKernelIssuedPlatformOperator } from "@oxagen/oxagen/platform-operator";
import type { KernelSecurityEvent } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { SecurityEventInput } from "@oxagen/telemetry";
import {
  describeTarget,
  instant,
  invokeAsPlatformOperator,
  readFlags,
  scaledDecimal,
  usdPer1000ToMicros,
  usdToCents,
  wholeNumber,
} from "./platform-operator-run";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";

describe("readFlags", () => {
  const known = { values: ["--org", "--n"], switches: ["--dry-run"] };

  it("reads values and switches in any order", () => {
    const f = readFlags(
      ["--dry-run", "--n", "3", "--org", "acme"],
      known,
      "usage",
    );
    expect(Object.fromEntries(f)).toEqual({
      "--dry-run": true,
      "--n": "3",
      "--org": "acme",
    });
  });

  it("refuses an unknown flag, and a value that is the next flag", () => {
    expect(() => readFlags(["--apply"], known, "usage")).toThrow(
      /unknown flag: --apply/,
    );
    expect(() => readFlags(["--org", "--n", "3"], known, "usage")).toThrow(
      /--org needs a value/,
    );
    expect(() => readFlags(["--org"], known, "usage")).toThrow(
      /--org needs a value/,
    );
  });
});

describe("the figure readers", () => {
  it.each([
    ["120000", 12_000_000],
    ["120,000", 12_000_000],
    ["5000.5", 500_050],
    ["0.01", 1],
  ])("reads %s dollars as %s cents, exactly", (raw, cents) => {
    expect(usdToCents(raw, "--x")).toBe(cents);
  });

  it.each(["1.005", "-1", "1e3", "$5", ""])(
    "refuses %j dollars rather than round",
    (raw) => {
      expect(() => usdToCents(raw, "--x")).toThrow(/--x/);
    },
  );

  it("reads a price per 1,000 as micros a unit", () => {
    expect(usdPer1000ToMicros("3.00", "--r")).toBe(3_000n);
    expect(usdPer1000ToMicros("12.345", "--r")).toBe(12_345n);
    expect(() => usdPer1000ToMicros("3.0001", "--r")).toThrow(
      /3 decimal places/,
    );
  });

  it("scales without floating point", () => {
    expect(scaledDecimal("9007199254740993", 2, "--x")).toBe(
      900719925474099300n,
    );
  });

  it("reads whole numbers with a floor", () => {
    expect(wholeNumber("2,000,000", "--gau", 1)).toBe(2_000_000);
    expect(() => wholeNumber("0", "--gau", 1)).toThrow(/>= 1/);
    expect(() => wholeNumber("1.5", "--gau", 1)).toThrow(/whole number/);
  });

  it("reads a bare date as midnight UTC, and an instant as given", () => {
    expect(instant("2027-10-01", "--to")).toEqual(
      new Date("2027-10-01T00:00:00.000Z"),
    );
    expect(instant("2026-10-01T09:30:00+02:00", "--to")).toEqual(
      new Date("2026-10-01T07:30:00.000Z"),
    );
    expect(() => instant("next year", "--to")).toThrow(/--to must be a date/);
    expect(() => instant("1700000000", "--to")).toThrow(/--to must be a date/);
  });
});

describe("invokeAsPlatformOperator", () => {
  function kernel(outcome: KernelSecurityEvent["outcome"] = "allow") {
    let emitter: ((e: KernelSecurityEvent) => void) | null = null;
    const order: string[] = [];
    const rows: SecurityEventInput[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const ctxs: CapabilityContext[] = [];
    return {
      order,
      rows,
      ctxs,
      release,
      deps: {
        setSecurityEventEmitter: vi.fn(
          (e: (event: KernelSecurityEvent) => void) => {
            order.push("register");
            emitter = e;
          },
        ),
        recordSecurityEvent: vi.fn(async (row: SecurityEventInput) => {
          rows.push(row);
          await held;
          order.push("row written");
        }),
        invoke: vi.fn(
          async (
            name: string,
            input: unknown,
            ctx: CapabilityContext,
            ...rest: unknown[]
          ) => {
            order.push(`invoke:${name}`);
            ctxs.push(ctx);
            expect(rest).toEqual([]);
            emitter?.({
              capability: name,
              outcome,
              surface: ctx.surface,
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              actorUserId: ctx.userId,
              requestId: ctx.requestId,
              errorCode: outcome === "allow" ? null : "authz_denied",
              durationMs: 1,
            });
            if (outcome !== "allow") throw new Error("authz_denied");
            return { ok: input };
          },
        ),
        requestId: "req-1",
      },
    };
  }

  it("registers the emitter, invokes with a minted binding on a tenantless runner context, and waits for the row", async () => {
    const k = kernel();
    const run = invokeAsPlatformOperator(
      { capability: "set_contract_terms", input: { a: 1 }, orgId: ORG },
      k.deps,
    );
    await vi.waitFor(() => expect(k.rows).toHaveLength(1));
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    k.release();

    await expect(run).resolves.toEqual({
      output: { ok: { a: 1 } },
      requestId: "req-1",
    });
    expect(k.order).toEqual([
      "register",
      "invoke:set_contract_terms",
      "row written",
    ]);
    const ctx = k.ctxs[0]!;
    expect(ctx).toMatchObject({
      orgId: "",
      workspaceId: "",
      userId: null,
      surface: "runner",
      requestId: "req-1",
    });
    expect(isKernelIssuedPlatformOperator(ctx.platformOperator)).toBe(true);
    expect(k.rows[0]).toMatchObject({
      eventType: "capability.invoke_allowed",
      orgId: ORG,
      workspaceId: null,
      capability: "set_contract_terms",
    });
  });

  it("writes and awaits the deny row when the kernel refuses", async () => {
    const k = kernel("deny");
    k.release();
    await expect(
      invokeAsPlatformOperator(
        { capability: "create_prepaid_invoice", input: {}, orgId: ORG },
        k.deps,
      ),
    ).rejects.toThrow(/authz_denied/);
    expect(k.rows[0]).toMatchObject({
      eventType: "capability.invoke_denied",
      orgId: ORG,
    });
    expect(k.order.at(-1)).toBe("row written");
  });

  it("mints a distinct binding per run", async () => {
    const k = kernel();
    k.release();
    await invokeAsPlatformOperator(
      { capability: "x", input: {}, orgId: ORG },
      k.deps,
    );
    await invokeAsPlatformOperator(
      { capability: "x", input: {}, orgId: ORG },
      k.deps,
    );
    expect(k.ctxs[0]!.platformOperator).not.toBe(k.ctxs[1]!.platformOperator);
  });
});

describe("describeTarget", () => {
  it("prints host, port and database with the credentials stripped", () => {
    expect(describeTarget("postgres://u:secret@db.example:6543/oxagen")).toBe(
      "db.example:6543/oxagen",
    );
    expect(describeTarget("not a url")).toBe("(unparseable DATABASE_URL)");
  });
});
