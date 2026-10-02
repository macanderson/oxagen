import {
  assignedFrom,
  type MetricOrder,
  type MetricRun,
  type UnproductiveClaim,
} from "@oxagen/billing";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import {
  OPERATOR_RANKING_RUNS_MAX,
  spendOperatorRanking,
} from "@oxagen/oxagen/contracts/spend.operator_ranking";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FrameTimeSpend,
  type FrameTimeSpendDeps,
  readFrameTimeSpend,
} from "./lib/frame-time-spend";
import { operatorPseudonym } from "./lib/operator-pseudonyms";
import {
  createOperatorRankingHandler,
  type OperatorRankingDeps,
  runsByOperator,
} from "./spend.operator_ranking";
import { ctx, SCOPE } from "./spend.test-support";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";
import type { RoleFixture } from "./test-utils/role-tx";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const ANA = "prn_0000000000000000000ana";
const BEN = "prn_0000000000000000000ben";
const CY = "prn_00000000000000000000cy";
const SALT = "0192d4a8-7c1e-7a00-8000-0000000005a1";

function runId(n: number): string {
  return `tse_${String(n).padStart(22, "0")}`;
}

/** One claimed frame. Detector 1 and USD unless the test says otherwise. */
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

function facts(id: string): OperatorFacts {
  return {
    id,
    name: `Name ${id.slice(-3)}`,
    email: null,
    avatarUrl: null,
    role: "Member",
  };
}

function harness(
  claims: UnproductiveClaim[],
  over: {
    spend?: FrameTimeSpend[];
    partial?: (string | null)[];
    policy?: { pseudonyms: boolean; salt: string | null };
    readOperatorSpend?: OperatorRankingDeps["readOperatorSpend"];
    metricRuns?: MetricRun[];
    orders?: MetricOrder[];
  } = {},
) {
  const deps = {
    readClaims: vi.fn(async () => claims),
    readOperatorSpend: vi.fn(
      over.readOperatorSpend ??
        (async () => ({
          rows: over.spend ?? [],
          partial: new Set(over.partial ?? []),
        })),
    ),
    readOperatorFacts: vi.fn(
      async (_scope: unknown, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, facts(id)])),
    ),
    readPolicy: vi.fn(async () => over.policy ?? { pseudonyms: false, salt: null }),
    readRuns: vi.fn(async () => over.metricRuns ?? []),
    priceSegments: vi.fn(async () => new Map()),
    readOrders: vi.fn(async () => over.orders ?? []),
  } satisfies OperatorRankingDeps;
  return { deps, handler: createOperatorRankingHandler(deps) };
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

afterEach(() => {
  resetRoleGate();
});

describe("get_operator_ranking figures", () => {
  const claims = [
    claim(1, "f1", ANA, 700n),
    claim(1, "f2", ANA, 300n),
    claim(2, "f1", ANA, 500n),
    claim(3, "f1", BEN, 900n),
    claim(4, "f1", CY, 100n),
    claim(4, "f2", BEN, 50n),
    claim(5, "f1", null, 250n),
  ];

  it("ranks operators by unproductive spend, highest first", async () => {
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.rank)).toEqual([1, 2, 3]);
    expect(
      out.operators.map((o) => (o.operator.kind === "named" ? o.operator.key : "")),
    ).toEqual([ANA, BEN, CY]);
    expect(out.operators.map((o) => o.unproductive.micros)).toEqual([
      "1500",
      "950",
      "100",
    ]);
    expect(() => spendOperatorRanking.output.parse(out)).not.toThrow();
  });

  it("sums the operator totals and the unattributed total to the headline", async () => {
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    const parts = [
      ...out.operators.map((o) => BigInt(o.unproductive.micros)),
      BigInt(out.unattributed.unproductive.micros),
    ];
    expect(sum(parts)).toBe(BigInt(out.unproductive.micros));
    expect(out.unproductive.micros).toBe("2800");
    expect(out.unattributed).toEqual({
      unproductive: { micros: "250", currency: "USD" },
      runs: 1,
    });
  });

  it("sums each operator's run figures to that operator's total", async () => {
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    for (const row of out.operators) {
      expect(sum(row.topRuns.map((r) => BigInt(r.unproductive.micros)))).toBe(
        BigInt(row.unproductive.micros),
      );
      expect(row.runs).toBe(row.topRuns.length);
    }
    const ana = out.operators[0];
    expect(ana?.topRuns).toEqual([
      { runId: runId(1), unproductive: { micros: "1000", currency: "USD" } },
      { runId: runId(2), unproductive: { micros: "500", currency: "USD" } },
    ]);
  });

  it("counts a frame two detectors claim once, under the lowest detector", async () => {
    const out = await harness([
      claim(1, "f1", ANA, 400n, 1),
      claim(1, "f1", ANA, 400n, 7),
      claim(1, "f2", ANA, 100n, 8),
    ]).handler({ period: PERIOD }, ctx());
    expect(out.unproductive.micros).toBe("500");
    expect(out.operators[0]?.unproductive.micros).toBe("500");
    expect(out.operators[0]?.topRuns[0]?.unproductive.micros).toBe("500");
  });

  it("gives each operator's share of the headline", async () => {
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.shareOfTotal)).toEqual([
      1500 / 2800,
      950 / 2800,
      100 / 2800,
    ]);
  });

  it("gives the unproductive share of each operator's priced spend, capped at 1, null with none priced", async () => {
    const out = await harness(claims, {
      spend: [
        { operatorKey: ANA, currency: "USD", micros: 6_000n },
        { operatorKey: BEN, currency: "USD", micros: 500n },
        { operatorKey: CY, currency: "EUR", micros: 1_000n },
      ],
    }).handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.unproductiveShare)).toEqual([
      0.25,
      1,
      null,
    ]);
  });

  it("gives no unproductive share when an operator's priced spend holds two currencies", async () => {
    const out = await harness(claims, {
      spend: [
        { operatorKey: ANA, currency: "USD", micros: 6_000n },
        { operatorKey: ANA, currency: "EUR", micros: 2_000n },
        { operatorKey: BEN, currency: "EUR", micros: 500n },
        { operatorKey: BEN, currency: "USD", micros: 1_900n },
        { operatorKey: CY, currency: "USD", micros: 400n },
      ],
    }).handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.unproductiveShare)).toEqual([
      null,
      null,
      0.25,
    ]);
  });

  it("gives no unproductive share to an operator whose spend misses an unpriced run", async () => {
    const out = await harness(claims, {
      spend: [
        { operatorKey: ANA, currency: "USD", micros: 6_000n },
        { operatorKey: BEN, currency: "USD", micros: 1_900n },
      ],
      partial: [BEN, null],
    }).handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.unproductiveShare)).toEqual([
      0.25,
      null,
      null,
    ]);
  });

  it("refuses a period whose claims hold two currencies", async () => {
    const h = harness([
      claim(1, "f1", ANA, 700n),
      claim(2, "f1", BEN, 300n, 1, "EUR"),
    ]);
    const refusal = h.handler({ period: PERIOD }, ctx());
    await expect(refusal).rejects.toMatchObject({
      code: "conflict",
      reason: "ranking_mixed_currency",
    });
    await expect(refusal).rejects.toThrow(/EUR and in USD/);
    expect(h.deps.readOperatorSpend).not.toHaveBeenCalled();
  });

  it("labels every figure with the claims' currency", async () => {
    const out = await harness([
      claim(1, "f1", ANA, 700n, 1, "EUR"),
      claim(2, "f1", null, 300n, 1, "EUR"),
    ]).handler({ period: PERIOD }, ctx());
    expect(out.unproductive).toEqual({ micros: "1000", currency: "EUR" });
    expect(out.unattributed.unproductive.currency).toBe("EUR");
    expect(out.operators[0]?.unproductive.currency).toBe("EUR");
    expect(out.operators[0]?.topRuns[0]?.unproductive.currency).toBe("EUR");
  });

  it("caps each operator's cited runs and keeps the full run count", async () => {
    const many = Array.from({ length: OPERATOR_RANKING_RUNS_MAX + 3 }, (_, i) =>
      claim(i + 1, "f1", ANA, BigInt(100 + i)),
    );
    const out = await harness(many).handler({ period: PERIOD }, ctx());
    const row = out.operators[0];
    expect(row?.runs).toBe(OPERATOR_RANKING_RUNS_MAX + 3);
    expect(row?.topRuns).toHaveLength(OPERATOR_RANKING_RUNS_MAX);
    expect(row?.topRuns[0]?.runId).toBe(runId(OPERATOR_RANKING_RUNS_MAX + 3));
  });

  it("answers a zero headline and no rows when nothing is claimed", async () => {
    const h = harness([]);
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out).toEqual({
      period: PERIOD,
      pseudonyms: false,
      unproductive: { micros: "0", currency: "USD" },
      unattributed: { unproductive: { micros: "0", currency: "USD" }, runs: 0 },
      operators: [],
    });
    expect(h.deps.readOperatorFacts).not.toHaveBeenCalled();
    expect(() => spendOperatorRanking.output.parse(out)).not.toThrow();
  });

  it("reads the caller's workspace over the whole last day", async () => {
    const h = harness(claims);
    await h.handler({ period: PERIOD }, ctx());
    const window = {
      start: new Date("2026-09-01T00:00:00.000Z"),
      end: new Date("2026-10-01T00:00:00.000Z"),
    };
    expect(h.deps.readClaims).toHaveBeenCalledWith(SCOPE, window);
    expect(h.deps.readOperatorSpend).toHaveBeenCalledWith(SCOPE, window, [
      ANA,
      BEN,
      CY,
    ]);
  });

  it("names each operator with the facts the reader returns", async () => {
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    expect(out.operators[0]?.operator).toEqual({
      kind: "named",
      key: ANA,
      facts: facts(ANA),
    });
  });
});

describe("get_operator_ranking pseudonyms", () => {
  const claims = [claim(1, "f1", ANA, 700n), claim(2, "f1", BEN, 300n)];
  const policy = { pseudonyms: true, salt: SALT };

  it("replaces each name with a pseudonym and drops the key, the facts, and the runs", async () => {
    const h = harness(claims, { policy });
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.pseudonyms).toBe(true);
    expect(out.operators.map((o) => o.operator)).toEqual([
      { kind: "pseudonym", pseudonym: operatorPseudonym(SALT, ANA) },
      { kind: "pseudonym", pseudonym: operatorPseudonym(SALT, BEN) },
    ]);
    expect(out.operators.every((o) => o.topRuns.length === 0)).toBe(true);
    expect(h.deps.readOperatorFacts).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(ANA);
    expect(() => spendOperatorRanking.output.parse(out)).not.toThrow();
  });

  it("withholds the figures that match a pseudonym to named spend", async () => {
    const h = harness(claims, {
      policy,
      spend: [{ operatorKey: ANA, currency: "USD", micros: 2_800n }],
    });
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.unproductiveShare)).toEqual([null, null]);
    expect(out.operators.map((o) => o.runs)).toEqual([null, null]);
    expect(h.deps.readOperatorSpend).not.toHaveBeenCalled();
  });

  it("keeps the unproductive figures and the ranks under pseudonyms", async () => {
    const out = await harness(claims, { policy }).handler(
      { period: PERIOD },
      ctx(),
    );
    expect(out.operators.map((o) => o.rank)).toEqual([1, 2]);
    expect(out.operators.map((o) => o.unproductive.micros)).toEqual([
      "700",
      "300",
    ]);
    expect(out.operators.map((o) => o.shareOfTotal)).toEqual([0.7, 0.3]);
    expect(out.unproductive.micros).toBe("1000");
  });

  it("keeps one operator's pseudonym the same across reads and apart from another's", () => {
    expect(operatorPseudonym(SALT, ANA)).toBe(operatorPseudonym(SALT, ANA));
    expect(operatorPseudonym(SALT, ANA)).not.toBe(operatorPseudonym(SALT, BEN));
    expect(operatorPseudonym(SALT, ANA)).toMatch(/^Operator [0-9A-F]{8}$/);
    expect(operatorPseudonym(SALT, ANA)).not.toBe(
      operatorPseudonym("0192d4a8-7c1e-7a00-8000-0000000005a2", ANA),
    );
  });

  it("names operators when the setting is on but the row has no salt", async () => {
    const out = await harness(claims, {
      policy: { pseudonyms: true, salt: null },
    }).handler({ period: PERIOD }, ctx());
    expect(out.pseudonyms).toBe(false);
    expect(out.operators[0]?.operator.kind).toBe("named");
  });
});

describe("get_operator_ranking roles", () => {
  const claims = [claim(1, "f1", ANA, 700n)];

  it.each<[string, RoleFixture]>([
    ["an org Owner", { org: "Owner" }],
    ["an org Admin", { org: "Admin" }],
    ["an org Admin who is a workspace Member", { org: "Admin", workspace: "Member" }],
  ])("lets %s read the ranking", async (_label, roles) => {
    roleGate.roles = roles;
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    expect(out.operators).toHaveLength(1);
  });

  // No person holds a workspace IAM role yet (#3198), so in an Enterprise
  // org the kernel refuses a workspace Owner before the handler runs. The
  // ranking names org roles only, and refuses the same people on every tier.
  it.each<[string, RoleFixture]>([
    ["an org Member", { org: "Member" }],
    ["an org Billing member", { org: "Billing" }],
    ["a workspace Member", { org: null, workspace: "Member" }],
    ["a workspace Owner who is an org Member", { org: "Member", workspace: "Owner" }],
    ["a workspace Owner with no org role", { org: null, workspace: "Owner" }],
    ["a workspace Admin who is an org Member", { org: "Member", workspace: "Admin" }],
  ])("denies %s before reading anything", async (_label, roles) => {
    roleGate.roles = roles;
    const h = harness(claims);
    await expect(h.handler({ period: PERIOD }, ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(h.deps.readClaims).not.toHaveBeenCalled();
    expect(h.deps.readPolicy).not.toHaveBeenCalled();
  });

  it("refuses a call with no acting person", async () => {
    roleGate.roles = { org: null };
    const h = harness(claims);
    await expect(
      h.handler({ period: PERIOD }, { ...ctx(), userId: null }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(h.deps.readClaims).not.toHaveBeenCalled();
  });
});

/**
 * The share's two sides count frames by the time they ran (#4574): the claims
 * reader filters on frame_at, and the spend reader prices a run that crosses
 * the period's edge by its frames inside the period.
 */
describe("get_operator_ranking share window", () => {
  const SEP_1 = new Date("2026-09-01T00:00:00.000Z");
  const OCT_1 = new Date("2026-10-01T00:00:00.000Z");

  // Ana's run 1 started on August 31 and ran into September: 9,000 priced in
  // all, 1,000 of it on September 1. Her run 2 ran inside September: 3,000.
  // Ben's run 3 started on September 30 and ran into October: 8,000 in all,
  // 2,000 of it on September 30. Postgres sorts the runs into the two lists
  // (frame-time-spend.pg.test.ts runs that SQL).
  const contained = [{ operatorKey: ANA, currency: "USD", micros: 3_000n }];
  const crossing = [
    { runId: runId(1), operatorKey: ANA, currency: "USD", costMicros: 9_000n },
    { runId: runId(3), operatorKey: BEN, currency: "USD", costMicros: 8_000n },
  ];
  // Run 1's claimed frame ran on September 1, and run 3's on September 30.
  const claims = [claim(1, "f1", ANA, 1_000n), claim(3, "f1", BEN, 500n)];
  const inPeriod = new Map([
    [runId(1), 1_000n],
    [runId(3), 2_000n],
  ]);

  function spendDeps() {
    return {
      readRuns: vi.fn(async () => ({ contained, crossing })),
      priceRunFrames: vi.fn(
        async (_scope: unknown, id: string) => inPeriod.get(id) ?? null,
      ),
      reportPriceFailure: vi.fn(),
    } satisfies FrameTimeSpendDeps;
  }

  it("divides by the frames that ran in the period for a run that crosses its first day", async () => {
    const deps = spendDeps();
    const out = await harness(claims, {
      readOperatorSpend: (scope, window, keys) =>
        readFrameTimeSpend(deps, scope, window, keys),
    }).handler({ period: PERIOD }, ctx());
    const ana = out.operators.find(
      (o) => o.operator.kind === "named" && o.operator.key === ANA,
    );
    // 1,000 over (1,000 from run 1 on September 1 + 3,000 from run 2).
    expect(ana?.unproductiveShare).toBe(0.25);
    expect(deps.priceRunFrames).toHaveBeenCalledWith(SCOPE, runId(1), {
      start: SEP_1,
      end: OCT_1,
    });
  });

  it("divides by the frames that ran in the period for a run that crosses its last day", async () => {
    const deps = spendDeps();
    const out = await harness(claims, {
      readOperatorSpend: (scope, window, keys) =>
        readFrameTimeSpend(deps, scope, window, keys),
    }).handler({ period: PERIOD }, ctx());
    const ben = out.operators.find(
      (o) => o.operator.kind === "named" && o.operator.key === BEN,
    );
    // 500 over the 2,000 run 3 spent on September 30, not its 8,000 in all.
    expect(ben?.unproductiveShare).toBe(0.25);
    expect(deps.priceRunFrames).toHaveBeenCalledTimes(2);
  });
});

describe("runsByOperator", () => {
  it("splits a run whose frames name two operators between them", () => {
    const runs = runsByOperator([
      claim(1, "f1", ANA, 100n),
      claim(1, "f2", BEN, 40n),
      claim(1, "f2", BEN, 40n, 7),
    ]);
    expect(runs.get(ANA)).toEqual(new Map([[runId(1), 100n]]));
    expect(runs.get(BEN)).toEqual(new Map([[runId(1), 40n]]));
  });
});

/**
 * Done work orders and the unassigned share beside each name (F33): done at
 * the first passing check run (decision 5), and unassigned spend with the
 * 24-hour grace window (decision 4), kept out of the unproductive figures
 * (decision 3).
 */
describe("get_operator_ranking done work orders and unassigned share", () => {
  const HOUR = 60 * 60 * 1000;
  const claims = [claim(1, "f1", ANA, 700n), claim(2, "f1", BEN, 300n)];
  const start = new Date("2026-09-10T09:00:00.000Z");

  function metricRun(
    n: number,
    operatorKey: string,
    costMicros: bigint,
    attachedAfterHours: number | null,
  ): MetricRun {
    return {
      runId: runId(n),
      operatorKey,
      agentKey: "acme.web.a",
      startedAt: start,
      lastFrameAt: new Date(start.getTime() + HOUR),
      costMicros,
      currency: "USD",
      tokens: 10,
      assignment: {
        kind: "direct",
        from: assignedFrom({
          openedAt: start,
          attachedAt:
            attachedAfterHours === null
              ? null
              : new Date(start.getTime() + attachedAfterHours * HOUR),
        }),
      },
      definitionOfDone: false,
    };
  }

  function order(
    publicId: string,
    operatorKey: string,
    passedAt: string | null,
  ): MetricOrder {
    return {
      id: `00000000-0000-7000-8000-${publicId.padStart(12, "0").slice(-12)}`,
      publicId,
      operatorKey,
      agentKey: "acme.web.a",
      dispatchedAt: new Date("2026-09-10T08:00:00.000Z"),
      closedAt: null,
      definitionOfDone: true,
      checks:
        passedAt === null
          ? [{ checkedAt: new Date("2026-09-10T10:00:00.000Z"), result: "failed" }]
          : [{ checkedAt: new Date(passedAt), result: "passed" }],
      rejections: [],
      runs: [
        {
          runId: runId(9),
          startedAt: new Date("2026-09-10T09:00:00.000Z"),
          costMicros: 1n,
          currency: "USD",
        },
      ],
    };
  }

  // Ana: run 1 (600) never attached, run 3 (400) attached at 23 hours.
  // Ben: run 2 (500) attached at 25 hours, run 4 (500) a send.
  const runs = [
    metricRun(1, ANA, 600n, null),
    metricRun(3, ANA, 400n, 23),
    metricRun(2, BEN, 500n, 25),
    { ...metricRun(4, BEN, 500n, null), assignment: { kind: "send" as const } },
  ];
  const orders = [
    order("wo_a1", ANA, "2026-09-11T10:00:00.000Z"),
    order("wo_a2", ANA, "2026-09-12T10:00:00.000Z"),
    // Passed in August: not done in this period.
    order("wo_a3", ANA, "2026-08-30T10:00:00.000Z"),
    // Failed and never passed: not done.
    order("wo_b1", BEN, null),
  ];

  it("shows each operator's done work orders, counted at the passing check", async () => {
    const out = await harness(claims, { metricRuns: runs, orders }).handler(
      { period: PERIOD },
      ctx(),
    );
    expect(out.operators.map((o) => o.doneWorkOrders)).toEqual([2, 0]);
    expect(out.operators[0]?.topDoneWorkOrders).toEqual([
      { workOrderId: "wo_a1", doneAt: "2026-09-11T10:00:00.000Z", runs: [runId(9)] },
      { workOrderId: "wo_a2", doneAt: "2026-09-12T10:00:00.000Z", runs: [runId(9)] },
    ]);
    expect(() => spendOperatorRanking.output.parse(out)).not.toThrow();
  });

  it("shows each operator's unassigned share with the 24-hour grace window", async () => {
    const out = await harness(claims, { metricRuns: runs, orders }).handler(
      { period: PERIOD },
      ctx(),
    );
    // Ana: 600 of 1,000 unassigned; run 3 was attached at 23 hours.
    // Ben: 500 of 1,000; run 2 was attached at 25 hours, after it ended.
    expect(out.operators.map((o) => o.unassignedShare)).toEqual([0.6, 0.5]);
    expect(out.operators[0]?.topUnassignedRuns).toEqual([
      { runId: runId(1), unassigned: { micros: "600", currency: "USD" } },
    ]);
    expect(out.operators[1]?.topUnassignedRuns.map((r) => r.runId)).toEqual([
      runId(2),
    ]);
  });

  it("leaves the unproductive figures and the headline unchanged by unassigned spend", async () => {
    const without = await harness(claims).handler({ period: PERIOD }, ctx());
    const withUnassigned = await harness(claims, {
      metricRuns: runs,
      orders,
    }).handler({ period: PERIOD }, ctx());
    expect(withUnassigned.unproductive).toEqual(without.unproductive);
    expect(withUnassigned.unproductive.micros).toBe("1000");
    expect(withUnassigned.operators.map((o) => o.unproductive)).toEqual(
      without.operators.map((o) => o.unproductive),
    );
  });

  it("keeps the done count and drops the share and the evidence under pseudonyms", async () => {
    const h = harness(claims, {
      metricRuns: runs,
      orders,
      policy: { pseudonyms: true, salt: SALT },
    });
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.operators.map((o) => o.doneWorkOrders)).toEqual([2, 0]);
    expect(out.operators.map((o) => o.unassignedShare)).toEqual([null, null]);
    expect(out.operators.every((o) => o.topDoneWorkOrders.length === 0)).toBe(true);
    expect(out.operators.every((o) => o.topUnassignedRuns.length === 0)).toBe(true);
    expect(h.deps.readRuns).not.toHaveBeenCalled();
  });

  it("reads the named operators' runs and the period's work orders", async () => {
    const h = harness(claims, { metricRuns: runs, orders });
    await h.handler({ period: PERIOD }, ctx());
    const window = {
      start: new Date("2026-09-01T00:00:00.000Z"),
      end: new Date("2026-10-01T00:00:00.000Z"),
    };
    expect(h.deps.readRuns).toHaveBeenCalledWith(SCOPE, window, [ANA, BEN]);
    expect(h.deps.readOrders).toHaveBeenCalledWith(SCOPE, window);
    // Every run falls inside the period and on one side of its attachment.
    expect(h.deps.priceSegments).not.toHaveBeenCalled();
  });
});
