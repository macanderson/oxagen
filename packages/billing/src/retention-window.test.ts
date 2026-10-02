/**
 * Unit tests for retention-window.ts: the evidence window an organisation's
 * billing basis includes (ADR-241, signup grant). Codex review on #4936
 * found `get_evidence_retention` reporting a subscriber's twelve months to an
 * organisation on its signup grant, while the Price list showed 30 days.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  readGauEntitlement: vi.fn(),
  readOrgBillingSettings: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

vi.mock(
  "./contract-terms",
  async (importOriginal) =>
    ({
      ...(await importOriginal<typeof import("./contract-terms")>()),
      readGauEntitlement: mocks.readGauEntitlement,
    }) satisfies Pick<typeof import("./contract-terms"), "readGauEntitlement">,
);

vi.mock(
  "./billing-settings",
  async (importOriginal) =>
    ({
      ...(await importOriginal<typeof import("./billing-settings")>()),
      readOrgBillingSettings: mocks.readOrgBillingSettings,
    }) satisfies Pick<
      typeof import("./billing-settings"),
      "readOrgBillingSettings"
    >,
);

const { resolveIncludedRetentionDays } = await import("./retention-window");
const { RETENTION_INCLUDED_MONTHS, SIGNUP_GRANT_RETENTION_DAYS } = await import(
  "./action-metering"
);

const ORG = "00000000-0000-0000-0000-00000000a0a2";
const NOW = new Date("2026-10-05T00:00:00.000Z");
const TERMS = {
  source: "published_tier" as const,
  tier: "free" as const,
  effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
  effectiveTo: null,
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};
const GRANT = {
  grantedGau: 33_000,
  grantedAt: new Date("2026-10-01T00:00:00.000Z"),
  expiresAt: new Date("2026-10-31T00:00:00.000Z"),
};

function entitlement(over: Record<string, unknown>) {
  return {
    terms: TERMS,
    subscription: null,
    grant: null,
    subscriptionRequiredAfterGrant: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({}),
  );
  mocks.readOrgBillingSettings.mockResolvedValue({
    approvedForInvoiceBilling: false,
  });
});

describe("resolveIncludedRetentionDays", () => {
  it("gives an organisation on its signup grant 30 days", async () => {
    mocks.readGauEntitlement.mockResolvedValue(entitlement({ grant: GRANT }));
    expect(await resolveIncludedRetentionDays(ORG, NOW)).toBe(
      SIGNUP_GRANT_RETENTION_DAYS,
    );
    expect(mocks.readGauEntitlement).toHaveBeenCalledWith({}, ORG, NOW);
    expect(mocks.readOrgBillingSettings).toHaveBeenCalledWith(ORG, {
      system: true,
    });
  });

  it("gives an organisation past its grant with no subscription 30 days", async () => {
    mocks.readGauEntitlement.mockResolvedValue(
      entitlement({
        grant: { ...GRANT, expiresAt: new Date("2026-10-02T00:00:00.000Z") },
      }),
    );
    expect(await resolveIncludedRetentionDays(ORG, NOW)).toBe(
      SIGNUP_GRANT_RETENTION_DAYS,
    );
  });

  it("gives a subscriber the included months", async () => {
    mocks.readGauEntitlement.mockResolvedValue(
      entitlement({
        grant: GRANT,
        subscription: {
          billingInterval: "month",
          currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
        },
      }),
    );
    expect(await resolveIncludedRetentionDays(ORG, NOW)).toBe(
      RETENTION_INCLUDED_MONTHS * 30,
    );
  });

  it("gives an organisation approved for invoice billing the included months without reading its entitlement", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue({
      approvedForInvoiceBilling: true,
    });
    expect(await resolveIncludedRetentionDays(ORG, NOW)).toBe(
      RETENTION_INCLUDED_MONTHS * 30,
    );
    expect(mocks.readGauEntitlement).not.toHaveBeenCalled();
  });
});
