/**
 * public-plans.test.ts — unit tests for toPlanCards and fetchPlanCards.
 *
 * Covers:
 *   - toPlanCards: maps PlanRow[] to Plan[] correctly (all fields)
 *   - toPlanCards: defensive features parsing (null → [], missing list → [])
 *   - fetchPlanCards: falls back to SUBSCRIPTION_PLANS-derived cards when DB rows=[]
 *   - fetchPlanCards: uses DB rows when they are available
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const { mockDbRows, mockSafeQuery } = vi.hoisted(() => {
  const mockDbRows: unknown[] = [];
  const mockSafeQuery = vi.fn(
    (_fn: () => Promise<unknown>, fallback: unknown) =>
      Promise.resolve(mockDbRows.length > 0 ? mockDbRows : fallback),
  );
  return { mockDbRows, mockSafeQuery };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./safe-query", () => ({ safeQuery: mockSafeQuery }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: vi.fn(),
  };
});
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    SUBSCRIPTION_PLANS: [
      {
        slug: "build-v2",
        displayName: "Build",
        tier: "build",
        monthlyCents: 2000,
        annualCents: 20000,
        includedCredits: 2000,
        seats: 5,
        features: { list: ["Feature A", "Feature B"] },
      },
      {
        slug: "scale-v2",
        displayName: "Scale",
        tier: "scale",
        monthlyCents: 9900,
        annualCents: 99000,
        includedCredits: 9900,
        seats: 25,
        features: { list: ["Feature C"] },
      },
    ],
  };
});
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn() },
}));

import { toPlanCards, fetchPlanCards } from "./public-plans";
import type {} from "@/components/billing/plan-card";

const SAMPLE_ROWS = [
  {
    publicId: "pub-1",
    slug: "build-v2",
    name: "Build",
    tier: "build",
    monthlyCents: 2000,
    annualCents: 20000,
    includedCreditCents: 2000,
    includedSeats: 5,
    features: { list: ["Feature A", "Feature B"] },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toPlanCards", () => {
  it("maps a PlanRow to a Plan correctly", () => {
    const cards = toPlanCards(SAMPLE_ROWS as never);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.publicId).toBe("pub-1");
    expect(card.slug).toBe("build-v2");
    expect(card.name).toBe("Build");
    expect(card.tier).toBe("build");
    expect(card.monthlyCents).toBe(2000);
    expect(card.annualCents).toBe(20000);
    expect(card.includedCreditCents).toBe(2000);
    expect(card.includedSeats).toBe(5);
  });

  it("maps features.list to { label } objects", () => {
    const cards = toPlanCards(SAMPLE_ROWS as never);
    expect(cards[0]?.features).toEqual([
      { label: "Feature A" },
      { label: "Feature B" },
    ]);
  });

  it("returns empty features when features is null", () => {
    const cards = toPlanCards([{ ...SAMPLE_ROWS[0], features: null }] as never);
    expect(cards[0]?.features).toEqual([]);
  });

  it("returns empty features when features.list is missing", () => {
    const cards = toPlanCards([
      { ...SAMPLE_ROWS[0], features: { other: "data" } },
    ] as never);
    expect(cards[0]?.features).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(toPlanCards([])).toEqual([]);
  });
});

describe("fetchPlanCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows.length = 0;
  });

  it("falls back to SUBSCRIPTION_PLANS-derived cards when DB returns empty", async () => {
    const cards = await fetchPlanCards();
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]?.slug).toBe("build-v2");
  });

  it("uses DB rows when safeQuery returns them", async () => {
    mockDbRows.push(...SAMPLE_ROWS);
    const cards = await fetchPlanCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.publicId).toBe("pub-1");
  });
});
