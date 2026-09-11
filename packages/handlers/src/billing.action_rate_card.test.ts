/**
 * Unit tests for the get_rate_card handler (billing.action_rate_card).
 *
 * The rate card is constants, so the constants are NOT restated here — the real
 * `@oxagen/billing` module is loaded and only `resolveOrgActionEntitlement` is
 * stubbed. A test that hard-coded $20/1,000 would keep passing after someone
 * changed the price, which is the one failure this capability cannot afford.
 *
 * Covers:
 *  - happy path validates against the contract's output schema;
 *  - enterprise's null published allowance, and the fallback the caller's own
 *    figure lands on;
 *  - free's shorter included retention window;
 *  - the zero model-token rate is published with an explanation, not omitted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOrgActionEntitlement: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgActionEntitlement: mocks.resolveOrgActionEntitlement,
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  ACTION_RATE_BANDS,
  ENTERPRISE_FALLBACK_ALLOWANCE,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  TIER_ACTION_ALLOWANCES,
} from "@oxagen/billing";
import { billingActionRateCard } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import { billingActionRateCardHandler } from "./billing.action_rate_card";
import { TEST_CTX } from "./test-utils/fixtures";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billingActionRateCardHandler", () => {
  it("publishes the live band table and validates against the contract", async () => {
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "scale",
      includedActionsAnnual: null,
    });

    const out = await billingActionRateCardHandler({}, TEST_CTX);

    // The strongest assertion available: the kernel validates output with this
    // schema, so a parse failure here is the drift the kernel would reject.
    expect(() => billingActionRateCard.output.parse(out)).not.toThrow();

    expect(out.unit).toBe("governed_action");
    expect(out.bands).toHaveLength(ACTION_RATE_BANDS.length);
    expect(out.bands.map((b) => b.id)).toEqual(
      ACTION_RATE_BANDS.map((b) => b.id),
    );
    expect(out.bands.map((b) => b.usdPer1000)).toEqual(
      ACTION_RATE_BANDS.map((b) => b.usdPer1000),
    );
    // Top band is open-ended; the schema allows null only there.
    expect(out.bands.at(-1)?.maxAnnualActions).toBeNull();

    expect(out.retention).toEqual({
      includedMonths: RETENTION_INCLUDED_MONTHS,
      usdPerGbMonth: RETENTION_USD_PER_GB_MONTH,
      optIn: true,
    });

    expect(out.yourTier).toBe("scale");
    expect(out.yourIncludedActionsAnnual).toBe(TIER_ACTION_ALLOWANCES.scale);
  });

  it("publishes enterprise's allowance as null and resolves the caller's own to the bounded fallback", async () => {
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "enterprise",
      includedActionsAnnual: null,
    });

    const out = await billingActionRateCardHandler({}, TEST_CTX);
    expect(() => billingActionRateCard.output.parse(out)).not.toThrow();

    const enterprise = out.tiers.find((t) => t.tier === "enterprise");
    // Null means "see your agreement", never "unlimited".
    expect(enterprise?.includedActionsAnnual).toBeNull();

    expect(out.yourTier).toBe("enterprise");
    // A mis-provisioned enterprise plan under-bills by a bounded amount rather
    // than running free.
    expect(out.yourIncludedActionsAnnual).toBe(ENTERPRISE_FALLBACK_ALLOWANCE);
  });

  it("uses the plan row's stored allowance over the tier default", async () => {
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "enterprise",
      includedActionsAnnual: 8_000_000,
    });

    const out = await billingActionRateCardHandler({}, TEST_CTX);
    expect(() => billingActionRateCard.output.parse(out)).not.toThrow();
    expect(out.yourIncludedActionsAnnual).toBe(8_000_000);
  });

  it("gives free a shorter included retention window than the paid tiers", async () => {
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "free",
      includedActionsAnnual: null,
    });

    const out = await billingActionRateCardHandler({}, TEST_CTX);
    expect(() => billingActionRateCard.output.parse(out)).not.toThrow();

    const byTier = new Map(out.tiers.map((t) => [t.tier, t]));
    expect(byTier.get("free")?.retentionMonths).toBe(1);
    for (const tier of ["build", "scale", "enterprise"] as const) {
      expect(byTier.get(tier)?.retentionMonths).toBe(RETENTION_INCLUDED_MONTHS);
    }
    expect(byTier.get("free")?.includedActionsAnnual).toBe(
      TIER_ACTION_ALLOWANCES.free,
    );
  });

  it("publishes the zero model-token rate with an explanation rather than omitting the line", async () => {
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "build",
      includedActionsAnnual: null,
    });

    const out = await billingActionRateCardHandler({}, TEST_CTX);
    expect(out.modelTokens.usdPerToken).toBe(0);
    expect(out.modelTokens.explanation.length).toBeGreaterThan(20);
    expect(out.modelTokens.explanation).toMatch(/BYOK|your own provider key/i);
    expect(out.summary.length).toBeGreaterThan(20);
  });
});
