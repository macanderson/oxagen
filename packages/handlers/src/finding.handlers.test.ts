/**
 * Unit tests for the finding handlers: list_findings, get_finding_evidence,
 * record_finding_fix and dismiss_finding.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so a refusal below comes from the handler alone. The role
 * gate runs for real against a tx double that answers the principal and
 * role-assignment tables; the finding reads and the decision write are
 * injected, so a test states the rows and asserts what the caller is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingEvidence as StoredEvidence } from "@oxagen/billing";
import { schema } from "@oxagen/database";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import {
  FINDINGS_LIST_MAX,
  findingList,
} from "@oxagen/oxagen/contracts/finding.list";
import { drizzle } from "drizzle-orm/postgres-js";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { createFindingDismissHandler } from "./finding.dismiss";
import { createFindingEvidenceHandler } from "./finding.evidence.get";
import { createFindingFixRecordHandler } from "./finding.fix.record";
import { createFindingListHandler } from "./finding.list";
import {
  type FindingDecisionDeps,
  type FindingRow,
  type FindingTotalRow,
  readFindingRows,
  readFindingTotals,
} from "./finding.shared";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const FINDING_ID = "fnd_0123456789abcdefghjkmn";
const DAY_MS = 86_400_000;
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date(START.getTime() + 30 * DAY_MS);

const ctx = () =>
  makeCTX({
    orgId: ORG,
    workspaceId: WS,
    userId: USER,
    requestId: "req_apply_1",
  });

/** Answers the role gate by the table asked for, so query order does not matter. */
function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.apiKeys) return [{ createdById: USER }];
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

function evidence(over: Partial<StoredEvidence> = {}): StoredEvidence {
  return {
    calls: 4,
    coveredCalls: 4,
    measuredTokens: 20_000,
    counterfactualTokens: 0,
    measuredMicros: "60000",
    counterfactualMicros: "0",
    operatorKeys: ["prn_aaaaaaaaaaaaaaaaaaaaaa"],
    runs: [
      {
        runId: "tse_0000000000000000000001",
        startedAt: "2026-09-10T12:00:00.000Z",
        calls: 4,
        measuredTokens: 20_000,
        counterfactualTokens: 0,
        measuredMicros: "60000",
        counterfactualMicros: "0",
      },
    ],
    ...over,
  };
}

function findingRow(over: Partial<FindingRow> = {}): FindingRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000f0001",
    publicId: FINDING_ID,
    orgId: ORG,
    workspaceId: WS,
    kind: "repeated_shell_commands",
    level: "tool",
    subject: "Bash",
    fingerprint: "repeated_shell_commands|tool|Bash",
    windowStart: START,
    windowEnd: END,
    estimatedSavingMicros: 60_000n,
    currency: "USD",
    savingBasis: "gateway_observed",
    confidence: "high",
    why: "4 calls on 1 run re-ran a shell command.",
    fix: "Serve an identical command from the run's earlier result.",
    citedRuns: ["tse_0000000000000000000001"],
    citedFrames: evidence(),
    status: "open",
    detectedAt: END,
    decidedAt: null,
    decidedByUserId: null,
    appliedActionId: null,
    ...over,
  };
}

/** One finding as the totals read answers it: its figures and its operators. */
function totalOf(row: FindingRow): FindingTotalRow {
  return {
    confidence: row.confidence,
    estimatedSavingMicros: row.estimatedSavingMicros,
    currency: row.currency,
    savingBasis: row.savingBasis,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    operatorKeys: (row.citedFrames as StoredEvidence).operatorKeys,
  };
}

type ListDeps = Parameters<typeof createFindingListHandler>[0];

/**
 * The list handler. Unless a test gives its own totals read, the totals read
 * answers every row the list read does, as in a workspace whose findings all
 * fit one answer.
 */
function listHandler(
  deps: Omit<ListDeps, "readFindingTotals"> &
    Partial<Pick<ListDeps, "readFindingTotals">>,
) {
  return createFindingListHandler({
    readFindingTotals: async (scope, filter) =>
      (await deps.readFindings(scope, filter)).map(totalOf),
    ...deps,
  });
}

describe("list_findings", () => {
  it("answers nulls and zero counts, without reading spend, when nothing is listed", async () => {
    const readPricedSpend = vi.fn();
    const handler = listHandler({
      readFindings: async () => [],
      readPricedSpend,
    });
    const out = await handler({ status: "open" }, ctx());
    expect(out).toEqual({
      status: "open",
      window: null,
      saving: null,
      spend: null,
      share: null,
      annualised: null,
      counts: { findings: 0, high: 0, medium: 0, operators: 0 },
      findings: [],
      truncated: false,
    });
    expect(readPricedSpend).not.toHaveBeenCalled();
  });

  it("sums the savings with their bases, annualises each over its own window, and divides by the spend over the findings' span", async () => {
    const readFindings = vi.fn(async () => [
      findingRow(),
      findingRow({
        publicId: "fnd_bbbbbbbbbbbbbbbbbbbbbb",
        kind: "unpaged_results",
        subject: "mcp__aws__cost",
        windowStart: new Date(START.getTime() + DAY_MS),
        estimatedSavingMicros: 30_000n,
        savingBasis: "client_attested",
        confidence: "medium",
        citedFrames: evidence({
          operatorKeys: [
            "prn_aaaaaaaaaaaaaaaaaaaaaa",
            "prn_bbbbbbbbbbbbbbbbbbbbbb",
          ],
        }),
      }),
    ]);
    const readPricedSpend = vi.fn(async () => ({
      micros: 900_000n,
      currency: "USD",
      basis: "gateway_observed" as const,
    }));
    const handler = listHandler({ readFindings, readPricedSpend });
    const out = await handler({ status: "open" }, ctx());

    expect(readFindings).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      { status: "open" },
    );
    // A read that names no run answers no citation.
    for (const f of out.findings) expect(f).not.toHaveProperty("citation");
    expect(readPricedSpend).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      { start: START, end: END },
    );
    expect(out.window).toEqual({
      from: START.toISOString(),
      to: END.toISOString(),
    });
    expect(out.saving).toEqual({
      micros: "90000",
      currency: "USD",
      basis: "mixed",
    });
    expect(out.spend).toEqual({
      micros: "900000",
      currency: "USD",
      basis: "gateway_observed",
    });
    // Each finding annualises over its own window: 60,000 micros over 30 days
    // is 730,000 over 365, and 30,000 over 29 days is 377,586.
    expect(out.annualised).toEqual({
      micros: "1107586",
      currency: "USD",
      basis: "mixed",
    });
    // 900,000 micros of spend over the 30-day span is 10,950,000 over 365.
    expect(out.share).toBeCloseTo(1_107_586 / 10_950_000, 12);
    expect(out.counts).toEqual({
      findings: 2,
      high: 1,
      medium: 1,
      operators: 2,
    });
    expect(out.findings.map((f) => f.id)).toEqual([
      FINDING_ID,
      "fnd_bbbbbbbbbbbbbbbbbbbbbb",
    ]);
    expect(out.truncated).toBe(false);
    expect(out.findings[0]).toMatchObject({
      saving: { micros: "60000", currency: "USD", basis: "gateway_observed" },
      runs: 1,
      calls: 4,
      window: { from: START.toISOString(), to: END.toISOString() },
    });
  });

  it("annualises a finding decided minutes ago over seven days, so its saving does not scale minutes to a year", async () => {
    const fiveMinutes = 5 * 60_000;
    const handler = listHandler({
      readFindings: async () => [
        findingRow(),
        findingRow({
          publicId: "fnd_bbbbbbbbbbbbbbbbbbbbbb",
          windowStart: new Date(END.getTime() - fiveMinutes),
          estimatedSavingMicros: 10_000n,
        }),
      ],
      readPricedSpend: async () => ({
        micros: 100_000_000n,
        currency: "USD",
        basis: "gateway_observed" as const,
      }),
    });
    const out = await handler({ status: "open" }, ctx());

    // 60,000 micros over 30 days is 730,000 over 365. 10,000 over its own
    // 5 minutes would be 1,051,200,000; over the 7-day minimum it is 521,429.
    expect(out.annualised?.micros).toBe("1251429");
    // The span is 30 days, so the share is 1,251,429 over 1,216,666,667 of
    // annualised spend: within the 30/7 minimum's factor of the plain 70,000
    // over 100,000,000.
    const share = out.share!;
    expect(share).toBeCloseTo((1_251_429 * 30) / (100_000_000 * 365), 12);
    expect(share).toBeLessThan((70_000 / 100_000_000) * (30 / 7));
  });

  it("scales the spend of a span shorter than seven days by the same minimum as the saving", async () => {
    const hour = 3_600_000;
    const handler = listHandler({
      readFindings: async () => [
        findingRow({
          windowStart: new Date(END.getTime() - hour),
          estimatedSavingMicros: 10_000n,
        }),
      ],
      readPricedSpend: async () => ({
        micros: 50_000n,
        currency: "USD",
        basis: "gateway_observed" as const,
      }),
    });
    const out = await handler({ status: "open" }, ctx());

    // 10,000 over the 7-day minimum is 521,429 a year, and the share is the
    // hour's plain 10,000 over 50,000.
    expect(out.annualised?.micros).toBe("521429");
    expect(out.share).toBeCloseTo(0.2, 6);
  });

  it("answers no share when nothing in the span was priced", async () => {
    const handler = listHandler({
      readFindings: async () => [findingRow()],
      readPricedSpend: async () => null,
    });
    const out = await handler({ status: "open" }, ctx());
    expect(out.spend).toBeNull();
    expect(out.share).toBeNull();
    expect(out.saving).not.toBeNull();
  });
});

describe("list_findings past one answer (#5262)", () => {
  /** `n` open findings, the i-th saving 10,000 + i micros under its own operator. */
  const many = (n: number): FindingRow[] =>
    Array.from({ length: n }, (_, i) =>
      findingRow({
        id: `0192d4a8-7c1e-7a00-8000-${String(i).padStart(12, "0")}`,
        publicId: `fnd_${String(i).padStart(22, "0")}`,
        estimatedSavingMicros: 10_000n + BigInt(i),
        confidence: i % 2 === 0 ? "high" : "medium",
        citedFrames: evidence({
          operatorKeys: [`prn_${String(i).padStart(22, "0")}`],
        }),
      }),
    );
  const spend = async () => ({
    micros: 900_000n,
    currency: "USD",
    basis: "gateway_observed" as const,
  });

  it("counts and totals every matched finding, and answers truncated when the list holds fewer", async () => {
    const all = many(FINDINGS_LIST_MAX + 12);
    const listed = all.slice(0, FINDINGS_LIST_MAX);
    const readFindingTotals = vi.fn(async () => all.map(totalOf));
    const handler = listHandler({
      readFindings: async () => listed,
      readFindingTotals,
      readPricedSpend: spend,
    });
    const out = await handler({ status: "open" }, ctx());

    expect(readFindingTotals).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      { status: "open" },
    );
    expect(out.truncated).toBe(true);
    expect(out.findings).toHaveLength(FINDINGS_LIST_MAX);
    expect(out.counts).toEqual({
      findings: FINDINGS_LIST_MAX + 12,
      high: (FINDINGS_LIST_MAX + 12) / 2,
      medium: (FINDINGS_LIST_MAX + 12) / 2,
      operators: FINDINGS_LIST_MAX + 12,
    });
    // The saving sums all 62 findings, not only the 50 listed.
    const sum = all.reduce((total, r) => total + r.estimatedSavingMicros, 0n);
    expect(out.saving?.micros).toBe(sum.toString());
    expect(() => findingList.output.parse(out)).not.toThrow();
  });

  it("answers truncated false when the list holds every matched finding", async () => {
    const all = many(FINDINGS_LIST_MAX);
    const handler = listHandler({
      readFindings: async () => all,
      readPricedSpend: spend,
    });
    const out = await handler({ status: "open" }, ctx());
    expect(out.truncated).toBe(false);
    expect(out.counts.findings).toBe(FINDINGS_LIST_MAX);
  });

  it("reads the totals with the list's filter and order, and no limit", async () => {
    const db = drizzle.mock({ schema });
    const compiled: { sql: string; params: unknown[] }[] = [];
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => { toSQL(): { sql: string; params: unknown[] } }) => {
        compiled.push(fn(db).toSQL());
        return Promise.resolve([]);
      },
    );
    const run = "tse_0000000000000000000001";
    await readFindingRows(
      { orgId: ORG, workspaceId: WS },
      { status: "open", runId: run },
    );
    await readFindingTotals(
      { orgId: ORG, workspaceId: WS },
      { status: "open", runId: run },
    );
    const [rows, totals] = compiled;
    // Drizzle names a column by its schema and table in a filter or an order
    // ("cost"."findings"."id"), and by its name alone in the select list.
    const order =
      /order by "cost"\."findings"\."estimated_saving_micros" desc, "cost"\."findings"\."id" asc/;
    expect(rows?.sql).toMatch(order);
    expect(rows?.sql).toMatch(/limit \$\d+/);
    expect(totals?.sql).toMatch(order);
    expect(totals?.sql).toMatch(/"findings"\."cited_runs" @> \$\d+/);
    expect(totals?.sql).not.toMatch(/limit/);
    // The totals read leaves the evidence and the text out, and reads only
    // the operators from the evidence.
    expect(totals?.sql).toMatch(/\("cited_frames" -> 'operatorKeys'\)::text/);
    expect(rows?.sql).toMatch(/"why"/);
    expect(totals?.sql).not.toMatch(/"why"/);
    expect(totals?.sql).not.toMatch(/"cited_frames",/);
  });

  it("parses each finding's operators from the stored evidence", async () => {
    const at = new Date(START);
    mocks.withTenantDb.mockImplementation(() =>
      Promise.resolve([
        {
          confidence: "high",
          estimatedSavingMicros: 60_000n,
          currency: "USD",
          savingBasis: "gateway_observed",
          windowStart: at,
          windowEnd: END,
          operatorKeys: '["prn_aaaaaaaaaaaaaaaaaaaaaa", "prn_bbbbbbbbbbbbbbbbbbbbbb"]',
        },
        {
          confidence: "medium",
          estimatedSavingMicros: 30_000n,
          currency: "USD",
          savingBasis: "gateway_observed",
          windowStart: at,
          windowEnd: END,
          operatorKeys: null,
        },
      ]),
    );
    const totals = await readFindingTotals(
      { orgId: ORG, workspaceId: WS },
      { status: "open" },
    );
    expect(totals.map((t) => t.operatorKeys)).toEqual([
      ["prn_aaaaaaaaaaaaaaaaaaaaaa", "prn_bbbbbbbbbbbbbbbbbbbbbb"],
      [],
    ]);
  });
});

describe("list_findings for one run (#4001)", () => {
  const RUN = "tse_0000000000000000000001";
  const SUBAGENT = "0192d4a8-7c1e-7a00-8000-0000000000bb";
  const spend = async () => ({
    micros: 900_000n,
    currency: "USD",
    basis: "gateway_observed" as const,
  });

  it("reads only the findings citing the run and answers the frames each cites there", async () => {
    const readFindings = vi.fn(async () => [
      findingRow({
        citedFrames: evidence({
          frames: {
            [RUN]: {
              // Two turns of one run, one call on a subagent's chain.
              seqs: [
                { seq: "14" },
                { seq: "3", sessionUuid: SUBAGENT },
                { seq: "92" },
              ],
              total: 3,
            },
          },
        }),
      }),
    ]);
    const handler = listHandler({
      readFindings,
      readPricedSpend: spend,
    });
    const out = await handler({ status: "open", runId: RUN }, ctx());
    expect(readFindings).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      { status: "open", runId: RUN },
    );
    expect(out.findings[0]?.citation).toEqual({
      runId: RUN,
      runLevel: false,
      frames: [
        { seq: "14" },
        { seq: "3", sessionUuid: SUBAGENT },
        { seq: "92" },
      ],
      framesTotal: 3,
    });
    expect(() => findingList.output.parse(out)).not.toThrow();
  });

  it("answers an empty list, with nulls and zero counts, for a run no finding cites", async () => {
    const handler = listHandler({
      readFindings: async () => [],
      readPricedSpend: spend,
    });
    const out = await handler({ status: "open", runId: RUN }, ctx());
    expect(out.findings).toEqual([]);
    expect(out.saving).toBeNull();
    expect(out.counts).toEqual({
      findings: 0,
      high: 0,
      medium: 0,
      operators: 0,
    });
    expect(() => findingList.output.parse(out)).not.toThrow();
  });

  it.each([
    "cache_writes_never_read",
    "standing_context",
    "model_class_fit",
  ] as const)(
    "cites the whole run for a %s finding, pinning no frame",
    async (kind) => {
      const handler = listHandler({
        readFindings: async () => [
          findingRow({
            kind,
            level: "operator",
            subject: "prn_aaaaaaaaaaaaaaaaaaaaaa",
          }),
        ],
        readPricedSpend: spend,
      });
      const out = await handler({ status: "open", runId: RUN }, ctx());
      expect(out.findings[0]?.citation).toEqual({
        runId: RUN,
        runLevel: true,
        frames: [],
        framesTotal: 0,
      });
    },
  );

  it("filters the read on the run's id among the cited runs, and reads every run without one", async () => {
    const db = drizzle.mock({ schema });
    const compiled: { sql: string; params: unknown[] }[] = [];
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => { toSQL(): { sql: string; params: unknown[] } }) => {
        compiled.push(fn(db).toSQL());
        return Promise.resolve([]);
      },
    );
    await readFindingRows(
      { orgId: ORG, workspaceId: WS },
      { status: "open", runId: RUN },
    );
    await readFindingRows({ orgId: ORG, workspaceId: WS }, { status: "open" });
    const [withRun, without] = compiled;
    expect(withRun?.sql).toMatch(/"findings"\."cited_runs" @> \$\d+/);
    expect(withRun?.params).toEqual(expect.arrayContaining([ORG, WS, "open"]));
    expect(JSON.stringify(withRun?.params)).toContain(RUN);
    // The select still lists the column; only the filter on it is absent.
    expect(without?.sql).not.toMatch(/"cited_runs" @>/);
  });

  it("answers null frames for a finding written before frames were stored, with its calls as the total", async () => {
    const handler = listHandler({
      readFindings: async () => [findingRow()],
      readPricedSpend: spend,
    });
    const out = await handler({ status: "open", runId: RUN }, ctx());
    expect(out.findings[0]?.citation).toEqual({
      runId: RUN,
      runLevel: false,
      frames: null,
      framesTotal: 4,
    });
    expect(() => findingList.output.parse(out)).not.toThrow();
  });

  it("answers no total for an older finding's run its evidence did not itemise", async () => {
    // The evidence itemises ten runs. The eleventh is cited but uncounted,
    // and its calls are not known to be zero.
    const eleventh = "tse_0000000000000000000011";
    const handler = listHandler({
      readFindings: async () => [
        findingRow({ citedRuns: ["tse_0000000000000000000001", eleventh] }),
      ],
      readPricedSpend: spend,
    });
    const out = await handler({ status: "open", runId: eleventh }, ctx());
    expect(out.findings[0]?.citation).toEqual({
      runId: eleventh,
      runLevel: false,
      frames: null,
      framesTotal: null,
    });
    expect(() => findingList.output.parse(out)).not.toThrow();
  });
});

/** Names each run in `names`, and leaves every other run unnamed. */
function readRunNames(names: Record<string, string> = {}) {
  return vi.fn(
    async (_scope: unknown, ids: readonly string[]) =>
      new Map<string, string | null>(ids.map((id) => [id, names[id] ?? null])),
  );
}

describe("get_finding_evidence", () => {
  it("answers the stored arithmetic as money in the finding's currency", async () => {
    const handler = createFindingEvidenceHandler({
      read: async () => findingRow(),
      readRunNames: readRunNames(),
    });
    const out = await handler({ findingId: FINDING_ID }, ctx());
    expect(out.evidence).toMatchObject({
      calls: 4,
      coveredCalls: 4,
      measured: { micros: "60000", currency: "USD" },
      counterfactual: { micros: "0", currency: "USD" },
    });
    expect(out.evidence.runs[0]).toMatchObject({
      runId: "tse_0000000000000000000001",
      name: null,
      measured: { micros: "60000", currency: "USD" },
    });
  });

  it("names each itemised run by its session name (#4571)", async () => {
    const names = readRunNames({
      tse_0000000000000000000001: "Repair the login redirect",
    });
    const handler = createFindingEvidenceHandler({
      read: async () => findingRow(),
      readRunNames: names,
    });
    const out = await handler({ findingId: FINDING_ID }, ctx());
    expect(names).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS }, [
      "tse_0000000000000000000001",
    ]);
    expect(out.evidence.runs[0]?.name).toBe("Repair the login redirect");
    expect(() => findingEvidenceGet.output.parse(out)).not.toThrow();
  });

  it("answers the setting the stored evidence names, and no key on a row that names none", async () => {
    const recommendation = {
      setting: "cache_ttl",
      value: "1h",
      current: "5m",
    };
    const row = findingRow({ citedFrames: evidence({ recommendation }) });
    const handler = createFindingEvidenceHandler({
      read: async () => row,
      readRunNames: readRunNames(),
    });
    const named = await handler({ findingId: FINDING_ID }, ctx());
    expect(named.finding.recommendation).toEqual(recommendation);
    const parsed = findingEvidenceGet.output.parse(named);
    expect(parsed.finding.recommendation).toEqual(recommendation);

    const bareHandler = createFindingEvidenceHandler({
      read: async () => findingRow(),
      readRunNames: readRunNames(),
    });
    const bare = await bareHandler({ findingId: FINDING_ID }, ctx());
    expect(bare.finding).not.toHaveProperty("recommendation");
  });

  // #5023: the card writes its text from the figures the job stored.
  it("answers the kind's stored values, and no key on a row written before values were stored", async () => {
    const values = {
      kind: "spin_loops" as const,
      tool: "Bash",
      repeats: 42,
    };
    const row = findingRow({
      kind: "spin_loops",
      level: "agent",
      subject: "reviewer",
      fingerprint: "spin_loops|agent|reviewer",
      citedFrames: evidence({ values }),
    });
    const handler = createFindingEvidenceHandler({
      read: async () => row,
      readRunNames: readRunNames(),
    });
    const out = await handler({ findingId: FINDING_ID }, ctx());
    expect(out.finding.values).toEqual(values);
    expect(findingEvidenceGet.output.parse(out).finding.values).toEqual(
      values,
    );

    // A row the job wrote before it stored values carries none, never zeros.
    const older = await createFindingEvidenceHandler({
      read: async () => findingRow(),
      readRunNames: readRunNames(),
    })({ findingId: FINDING_ID }, ctx());
    expect(older.finding).not.toHaveProperty("values");
  });

  it("drops stored values that do not parse or name another kind, so the list still answers (negative)", async () => {
    const wrongKind = findingRow({
      citedFrames: evidence({
        values: { kind: "spin_loops", tool: "Bash", repeats: 42 },
      }),
    });
    const malformed = findingRow({
      kind: "spin_loops",
      level: "agent",
      subject: "reviewer",
      fingerprint: "spin_loops|agent|reviewer",
      citedFrames: evidence({
        values: { kind: "spin_loops", tool: "", repeats: -1 } as never,
      }),
    });
    for (const row of [wrongKind, malformed]) {
      const out = await createFindingEvidenceHandler({
        read: async () => row,
        readRunNames: readRunNames(),
      })({ findingId: FINDING_ID }, ctx());
      expect(out.finding).not.toHaveProperty("values");
      expect(() => findingEvidenceGet.output.parse(out)).not.toThrow();
    }
  });

  it("refuses an id with no finding in the workspace as not found", async () => {
    const read = vi.fn(async () => null);
    const names = readRunNames();
    const handler = createFindingEvidenceHandler({ read, readRunNames: names });
    await expect(
      handler({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "finding_not_found",
    });
    expect(read).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
    );
    expect(names).not.toHaveBeenCalled();
  });
});

function decisionDeps(over: Partial<FindingDecisionDeps> = {}) {
  const now = new Date("2026-09-15T09:00:00.000Z");
  return {
    now: () => now,
    decide: vi.fn(async (_s, _id, d) =>
      findingRow({
        status: d.status,
        decidedAt: d.decidedAt,
        decidedByUserId: d.decidedByUserId,
        appliedActionId: d.appliedActionId,
      }),
    ),
    read: vi.fn(async () => findingRow()),
    ...over,
  } satisfies FindingDecisionDeps;
}

describe("record_finding_fix", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("records the fix as applied with this invocation's request id and the deciding user", async () => {
    stubRole("Owner");
    const deps = decisionDeps();
    const out = await createFindingFixRecordHandler(deps)(
      { findingId: FINDING_ID },
      ctx(),
    );
    expect(deps.decide).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
      {
        status: "applied",
        decidedAt: new Date("2026-09-15T09:00:00.000Z"),
        decidedByUserId: USER,
        appliedActionId: "req_apply_1",
      },
    );
    expect(out.finding).toMatchObject({
      status: "applied",
      appliedActionId: "req_apply_1",
      decidedAt: "2026-09-15T09:00:00.000Z",
    });
  });

  it("records an API-key call as the key's creator and gates on the creator's role", async () => {
    stubRole("Admin");
    const deps = decisionDeps();
    await createFindingFixRecordHandler(deps)(
      { findingId: FINDING_ID },
      makeCTX({
        orgId: ORG,
        workspaceId: WS,
        userId: null,
        apiKeyId: "key_1",
        requestId: "req_apply_1",
      }),
    );
    expect(deps.decide).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
      expect.objectContaining({ decidedByUserId: USER }),
    );
  });

  it("refuses a Member before touching the finding", async () => {
    stubRole("Member");
    const deps = decisionDeps();
    await expect(
      createFindingFixRecordHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it("refuses a call with no signed-in user", async () => {
    const deps = decisionDeps();
    await expect(
      createFindingFixRecordHandler(deps)(
        { findingId: FINDING_ID },
        makeCTX({ orgId: ORG, workspaceId: WS, userId: null }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it("refuses a finding someone already decided as a conflict", async () => {
    stubRole("Admin");
    const deps = decisionDeps({
      decide: vi.fn(async () => null),
      read: vi.fn(async () => findingRow({ status: "dismissed" })),
    });
    await expect(
      createFindingFixRecordHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "conflict", reason: "finding_not_open" });
  });

  it("refuses an id with no finding in the workspace as not found", async () => {
    stubRole("Owner");
    const deps = decisionDeps({
      decide: vi.fn(async () => null),
      read: vi.fn(async () => null),
    });
    await expect(
      createFindingFixRecordHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "finding_not_found" });
  });
});

describe("dismiss_finding", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("dismisses an open finding with no action id", async () => {
    stubRole("Admin");
    const deps = decisionDeps();
    const out = await createFindingDismissHandler(deps)(
      { findingId: FINDING_ID },
      ctx(),
    );
    expect(deps.decide).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
      expect.objectContaining({ status: "dismissed", appliedActionId: null }),
    );
    expect(out.finding).toMatchObject({
      status: "dismissed",
      appliedActionId: null,
    });
  });

  it("refuses a Billing member", async () => {
    stubRole("Billing");
    const deps = decisionDeps();
    await expect(
      createFindingDismissHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(deps.decide).not.toHaveBeenCalled();
  });
});
