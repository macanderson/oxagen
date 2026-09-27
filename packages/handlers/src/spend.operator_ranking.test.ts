import type { UnproductiveClaim } from "@oxagen/billing";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import {
  OPERATOR_RANKING_RUNS_MAX,
  spendOperatorRanking,
} from "@oxagen/oxagen/contracts/spend.operator_ranking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorPseudonym } from "./lib/operator-pseudonyms";
import {
  createOperatorRankingHandler,
  type OperatorRankingDeps,
  type OperatorSpend,
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

/** One claimed frame. Detector 1 unless the test says otherwise. */
function claim(
  run: number,
  frame: string,
  operatorKey: string | null,
  micros: bigint,
  detector = 1,
): UnproductiveClaim {
  return {
    detector,
    runId: runId(run),
    frameKey: frame,
    operatorKey,
    costMicros: micros,
    currency: "USD",
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
    spend?: OperatorSpend[];
    policy?: { pseudonyms: boolean; salt: string | null };
  } = {},
) {
  const deps = {
    readClaims: vi.fn(async () => claims),
    readOperatorSpend: vi.fn(async () => over.spend ?? []),
    readOperatorFacts: vi.fn(
      async (_scope: unknown, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, facts(id)])),
    ),
    readPolicy: vi.fn(async () => over.policy ?? { pseudonyms: false, salt: null }),
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
    expect(out.operators.map((o) => o.runs)).toEqual([1, 1]);
    expect(h.deps.readOperatorFacts).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(ANA);
    expect(() => spendOperatorRanking.output.parse(out)).not.toThrow();
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
    ["the workspace Owner", { org: "Member", workspace: "Owner" }],
    ["a workspace Owner with no org role", { org: null, workspace: "Owner" }],
  ])("lets %s read the ranking", async (_label, roles) => {
    roleGate.roles = roles;
    const out = await harness(claims).handler({ period: PERIOD }, ctx());
    expect(out.operators).toHaveLength(1);
  });

  it.each<[string, RoleFixture]>([
    ["an org Member", { org: "Member" }],
    ["an org Billing member", { org: "Billing" }],
    ["a workspace Member", { org: null, workspace: "Member" }],
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
