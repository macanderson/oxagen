import type { UnproductiveClaim } from "@oxagen/billing";
import { FINDING_KINDS } from "@oxagen/database/schema";
import {
  spendUnproductive,
  UNPRODUCTIVE_ESTIMATE,
  UNPRODUCTIVE_PARTS,
} from "@oxagen/oxagen/contracts/spend.unproductive";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameTimeSpend } from "./lib/frame-time-spend";
import { createOperatorRankingHandler } from "./spend.operator_ranking";
import { ctx, SCOPE } from "./spend.test-support";
import {
  createUnproductiveSpendHandler,
  type KindSaving,
  spendIn,
  type UnproductiveSpendDeps,
} from "./spend.unproductive";
import { resetRoleGate } from "./test-utils/org-role-gate";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const WINDOW = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};
const ANA = "prn_0000000000000000000ana";
const BEN = "prn_0000000000000000000ben";

function runId(n: number): string {
  return `tse_${String(n).padStart(22, "0")}`;
}

function claim(
  run: number,
  frame: string,
  operatorKey: string | null,
  micros: bigint,
  detector = 1,
  currency = "USD",
): UnproductiveClaim {
  return {
    detector,
    runId: runId(run),
    frameKey: frame,
    operatorKey,
    costMicros: micros,
    currency,
  };
}

function saving(
  kind: string,
  micros: bigint,
  findings = 1,
  currency = "USD",
): KindSaving {
  return { kind, currency, micros, findings };
}

function harness(
  claims: UnproductiveClaim[],
  over: {
    savings?: KindSaving[];
    spend?: FrameTimeSpend[];
    partial?: (string | null)[];
  } = {},
) {
  const deps = {
    readClaims: vi.fn(async () => claims),
    readSpend: vi.fn(async () => ({
      rows: over.spend ?? [],
      partial: new Set(over.partial ?? []),
    })),
    readKindSavings: vi.fn(async () => over.savings ?? []),
  } satisfies UnproductiveSpendDeps;
  return { deps, handler: createUnproductiveSpendHandler(deps) };
}

const claims = [
  claim(1, "f1", ANA, 700n),
  claim(1, "f1", ANA, 700n, 7),
  claim(1, "f2", ANA, 300n, 8),
  claim(2, "f1", BEN, 900n),
  claim(3, "f1", null, 100n, 7),
];

afterEach(() => {
  resetRoleGate();
});

describe("get_unproductive_spend headline", () => {
  it("adds each claimed frame once, under the first detector that claims it", async () => {
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    // 700 (claimed by 1 and 7, counted once) + 300 + 900 + 100.
    expect(out.unproductive).toEqual({ micros: "2000", currency: "USD" });
    expect(() => spendUnproductive.output.parse(out)).not.toThrow();
  });

  it("answers the same total as the operator ranking for the same claims and period", async () => {
    const headline = await harness(claims).handler({ period: PERIOD }, ctx());
    const ranking = await createOperatorRankingHandler({
      readClaims: async () => claims,
      readOperatorSpend: async () => ({ rows: [], partial: new Set() }),
      readOperatorFacts: async () => new Map(),
      readPolicy: async () => ({ pseudonyms: false, salt: null }),
      readRuns: async () => [],
      priceSegments: async () => new Map(),
      readOrders: async () => [],
    })({ period: PERIOD }, ctx());
    expect(headline.unproductive).toEqual(ranking.unproductive);
  });

  it("names only kinds the findings job writes, so a renamed kind fails here", () => {
    const kinds: readonly string[] = FINDING_KINDS;
    for (const kind of [
      ...UNPRODUCTIVE_PARTS.flatMap((p) => p.kinds),
      ...UNPRODUCTIVE_ESTIMATE.kinds,
    ])
      expect(kinds).toContain(kind);
  });

  it("reads the caller's workspace over the whole last day", async () => {
    const h = harness(claims);
    await h.handler({ period: PERIOD }, ctx());
    expect(h.deps.readClaims).toHaveBeenCalledWith(SCOPE, WINDOW);
    expect(h.deps.readSpend).toHaveBeenCalledWith(SCOPE, WINDOW);
    expect(h.deps.readKindSavings).toHaveBeenCalledWith(SCOPE, WINDOW, [
      "standing_context",
      "cache_writes_never_read",
      "idle_cache_rewrites",
      "cache_busts",
      "unpaged_results",
      "model_class_fit",
    ]);
  });

  it("answers a zero headline with every part at zero when nothing is claimed or found", async () => {
    const out = await harness([]).handler({ period: PERIOD }, ctx());
    const zero = { saving: { micros: "0", currency: "USD" }, findings: 0 };
    expect(out).toEqual({
      period: PERIOD,
      unproductive: { micros: "0", currency: "USD" },
      spend: null,
      share: null,
      parts: [
        { detector: 2, ...zero },
        { detector: 3, ...zero },
        { detector: 5, ...zero },
      ],
      estimate: zero,
    });
    expect(() => spendUnproductive.output.parse(out)).not.toThrow();
  });
});

describe("get_unproductive_spend share", () => {
  it("divides the headline by the frame-time spend of every run", async () => {
    const out = await harness(claims, {
      spend: [
        { operatorKey: ANA, currency: "USD", micros: 5_000n },
        { operatorKey: BEN, currency: "USD", micros: 2_000n },
        { operatorKey: null, currency: "USD", micros: 1_000n },
      ],
    }).handler({ period: PERIOD }, ctx());
    expect(out.spend).toEqual({ micros: "8000", currency: "USD" });
    expect(out.share).toBe(0.25);
  });

  it("gives no share when a run that crosses the period's edge was left unpriced", async () => {
    const out = await harness(claims, {
      spend: [{ operatorKey: ANA, currency: "USD", micros: 5_000n }],
      partial: [BEN],
    }).handler({ period: PERIOD }, ctx());
    expect(out.spend).toBeNull();
    expect(out.share).toBeNull();
  });

  it("gives no share when the priced spend holds another currency", async () => {
    const out = await harness(claims, {
      spend: [
        { operatorKey: ANA, currency: "USD", micros: 5_000n },
        { operatorKey: BEN, currency: "EUR", micros: 2_000n },
      ],
    }).handler({ period: PERIOD }, ctx());
    expect(out.spend).toBeNull();
    expect(out.share).toBeNull();
  });

  it("caps the share at 1", async () => {
    const out = await harness(claims, {
      spend: [{ operatorKey: ANA, currency: "USD", micros: 1_000n }],
    }).handler({ period: PERIOD }, ctx());
    expect(out.share).toBe(1);
  });

  it("gives no figure for spend nothing priced", () => {
    expect(spendIn({ rows: [], partial: new Set() }, "USD")).toBeNull();
  });
});

describe("get_unproductive_spend parts and estimate", () => {
  const savings = [
    saving("standing_context", 400n, 2),
    saving("cache_writes_never_read", 50n),
    saving("idle_cache_rewrites", 120n),
    saving("cache_busts", 30n, 3),
    saving("unpaged_results", 600n),
    saving("model_class_fit", 1_500n, 4),
  ];

  it("sums each part detector's findings beside the headline", async () => {
    const out = await harness(claims, { savings }).handler(
      { period: PERIOD },
      ctx(),
    );
    expect(out.parts).toEqual([
      { detector: 2, saving: { micros: "400", currency: "USD" }, findings: 2 },
      { detector: 3, saving: { micros: "200", currency: "USD" }, findings: 5 },
      { detector: 5, saving: { micros: "600", currency: "USD" }, findings: 1 },
    ]);
    expect(out.estimate).toEqual({
      saving: { micros: "1500", currency: "USD" },
      findings: 4,
    });
  });

  it("keeps the parts and the estimate out of the headline", async () => {
    const without = await harness(claims).handler({ period: PERIOD }, ctx());
    const withParts = await harness(claims, { savings }).handler(
      { period: PERIOD },
      ctx(),
    );
    expect(withParts.unproductive).toEqual(without.unproductive);
  });

  it("refuses a period whose figures hold two currencies", async () => {
    const h = harness(claims, {
      savings: [saving("standing_context", 400n, 1, "EUR")],
    });
    const refusal = h.handler({ period: PERIOD }, ctx());
    await expect(refusal).rejects.toMatchObject({
      code: "conflict",
      reason: "unproductive_mixed_currency",
    });
    await expect(refusal).rejects.toThrow(/EUR and in USD/);
  });

  it("labels every figure with the one currency the period holds", async () => {
    const out = await harness([claim(1, "f1", ANA, 700n, 1, "EUR")], {
      savings: [saving("model_class_fit", 90n, 1, "EUR")],
    }).handler({ period: PERIOD }, ctx());
    expect(out.unproductive.currency).toBe("EUR");
    expect(out.parts.every((p) => p.saving.currency === "EUR")).toBe(true);
    expect(out.estimate.saving).toEqual({ micros: "90", currency: "EUR" });
  });
});
