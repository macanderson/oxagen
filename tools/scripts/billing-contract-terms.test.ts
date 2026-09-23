/**
 * Unit tests for billing-contract-terms: the flags, the dry run, and the
 * input `set_contract_terms` receives. The invoke path itself
 * (lib/platform-operator-run.ts) has its own tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  parseContractTermsFlags,
  runContractTerms,
  type ContractTermsRunDeps,
} from "./billing-contract-terms";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const NOW = new Date("2026-09-23T12:00:00.000Z");

const argv = [
  "--org",
  "acme",
  "--agreement",
  "MSA-2026-014",
  "--rate-per-1000-usd",
  "3.00",
  "--block-size",
  "10000",
  "--included-per-month",
  "250000",
];

function deps(over: Partial<ContractTermsRunDeps> = {}) {
  const lines: string[] = [];
  const invoke = vi.fn(
    async (_name: string, input: unknown, _ctx: CapabilityContext) => {
      const i = input as Record<string, unknown>;
      return {
        orgId: i.orgId,
        agreementRef: i.agreementRef,
        currency: i.currency,
        ratePerGauMicros: i.ratePerGauMicros,
        blockSizeGau: i.blockSizeGau,
        includedGauPerMonth: i.includedGauPerMonth,
        effectiveFrom: new Date(i.effectiveFrom as string).toISOString(),
        changed: true,
        previous: {
          agreementRef: "MSA-2025-003",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveTo: new Date(i.effectiveFrom as string).toISOString(),
        },
      };
    },
  );
  const d: ContractTermsRunDeps = {
    resolveOrg: async () => ({ id: ORG, name: "Acme" }),
    readDefaults: async () => ({
      currency: "usd",
      agreementRef: "MSA-2025-003",
      ratePerGauMicros: 4_000n,
    }),
    invoke,
    setSecurityEventEmitter: vi.fn(),
    recordSecurityEvent: vi.fn(async () => {}),
    requestId: "req-1",
    log: (l) => lines.push(l),
    now: () => NOW,
    ...over,
  };
  return { d, invoke, lines };
}

describe("parseContractTermsFlags", () => {
  it("reads the rate per 1,000 in dollars as micros a unit", () => {
    expect(parseContractTermsFlags(argv)).toEqual({
      orgSlug: "acme",
      agreementRef: "MSA-2026-014",
      ratePerGauMicros: 3_000n,
      blockSizeGau: 10_000,
      includedGauPerMonth: 250_000,
      effectiveFrom: null,
      dryRun: false,
    });
  });

  it("reads --from and --dry-run", () => {
    expect(
      parseContractTermsFlags([...argv, "--from", "2026-10-01", "--dry-run"]),
    ).toMatchObject({
      effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
      dryRun: true,
    });
  });

  it.each([
    "--org",
    "--agreement",
    "--rate-per-1000-usd",
    "--block-size",
    "--included-per-month",
  ])("requires %s", (flag) => {
    const i = argv.indexOf(flag);
    const without = [...argv.slice(0, i), ...argv.slice(i + 2)];
    expect(() => parseContractTermsFlags(without)).toThrow(
      new RegExp(`${flag} is required`),
    );
  });

  it("refuses a block size of 0", () => {
    const i = argv.indexOf("--block-size");
    const bad = [...argv];
    bad[i + 1] = "0";
    expect(() => parseContractTermsFlags(bad)).toThrow(
      /--block-size must be a whole number >= 1/,
    );
  });
});

describe("runContractTerms", () => {
  it("invokes set_contract_terms with the resolved org, the rate as digits and the start as an instant", async () => {
    const { d, invoke, lines } = deps();

    const stored = await runContractTerms(parseContractTermsFlags(argv), d);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0]).toBe("set_contract_terms");
    expect(invoke.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      currency: "usd",
      ratePerGauMicros: "3000",
      blockSizeGau: 10_000,
      includedGauPerMonth: 250_000,
      effectiveFrom: NOW.toISOString(),
    });
    expect(stored?.changed).toBe(true);
    expect(lines.join("\n")).toMatch(/In force {5}: MSA-2025-003/);
    expect(lines.join("\n")).toMatch(/Block {8}: 10,000 units for \$30\.00/);
    expect(lines.join("\n")).toMatch(/closing MSA-2025-003/);
  });

  it("validates and prints on a dry run, and invokes nothing", async () => {
    const { d, invoke, lines } = deps();
    expect(
      await runContractTerms(
        parseContractTermsFlags([...argv, "--dry-run"]),
        d,
      ),
    ).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(d.setSecurityEventEmitter).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatch(/Dry run: nothing written/);
  });

  it("refuses a block that does not cost whole cents before invoking, on a dry run too", async () => {
    const { d, invoke } = deps();
    const bad = parseContractTermsFlags([...argv, "--dry-run"]);
    bad.ratePerGauMicros = 3_333n;
    bad.blockSizeGau = 1_000;
    await expect(runContractTerms(bad, d)).rejects.toMatchObject({
      reason: "block_not_whole_cents",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an unknown slug before invoking anything", async () => {
    const { d, invoke } = deps({ resolveOrg: async () => null });
    await expect(
      runContractTerms(parseContractTermsFlags(argv), d),
    ).rejects.toThrow(/no organisation with slug "acme"/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
