import {
  RUN_STATEMENT_COLUMNS,
  spendStatementExport,
  STATEMENT_COLUMNS,
} from "@oxagen/oxagen/contracts/spend.statement.export";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import type { DailyTotalsRecord, SpendGroupKind } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import {
  type RunWorkItem,
  type RunWorkOrderRef,
  workOrderKey,
} from "./lib/run-work-items";
import {
  createSpendStatementHandler,
  csvField,
  csvText,
  monthBounds,
} from "./spend.statement.export";
import type { SpendRunRecord, SpendScope } from "./spend.shared";
import {
  ctx,
  daily,
  OPERATOR,
  pricedRun,
  run,
  SCOPE,
} from "./spend.test-support";

function harness(
  rows: DailyTotalsRecord[],
  runs: SpendRunRecord[] = [],
  people: OperatorFacts[] = [],
  items: [RunWorkOrderRef, RunWorkItem][] = [],
) {
  const readDailyTotals = vi.fn(
    async (
      _scope: SpendScope,
      q: { from: string; to: string; groupKind: SpendGroupKind },
    ) =>
      rows.filter(
        (r) => r.groupKind === q.groupKind && r.day >= q.from && r.day <= q.to,
      ),
  );
  const readRunTotals = vi.fn(
    async (_scope: SpendScope, _q: { from: string; to: string }) => runs,
  );
  const readOperatorFacts = vi.fn(
    async (_scope: unknown, keys: readonly string[]) =>
      new Map(
        people
          .filter((person) => keys.includes(person.id))
          .map((person): [string, OperatorFacts] => [person.id, person]),
      ),
  );
  const readRunWorkItems = vi.fn(
    async (_scope: unknown, orders: readonly RunWorkOrderRef[]) => {
      const wanted = new Set(orders.map((order) => workOrderKey(order)));
      return new Map(
        items
          .map(([order, item]): [string, RunWorkItem] => [
            workOrderKey(order),
            item,
          ])
          .filter(([key]) => wanted.has(key)),
      );
    },
  );
  return {
    handler: createSpendStatementHandler({
      readDailyTotals,
      readRunTotals,
      readOperatorFacts,
      readRunWorkItems,
    }),
    readDailyTotals,
    readRunTotals,
    readOperatorFacts,
    readRunWorkItems,
  };
}

const GROUPS = { month: "2026-09", format: "csv", rows: "groups" } as const;
const RUNS = { month: "2026-09", format: "csv", rows: "runs" } as const;

describe("monthBounds", () => {
  it("spans the first to the last day of the month, leap years included", () => {
    expect(monthBounds("2026-09")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(monthBounds("2028-02")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(monthBounds("2026-12")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });
});

describe("csvField", () => {
  it("quotes a field with a comma, a quote or a line break and leaves the rest bare", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField('a "quoted", key')).toBe('"a ""quoted"", key"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("csvText", () => {
  it("keeps a value a spreadsheet would run as a formula as text, then quotes it", () => {
    expect(csvText("Fix the login page")).toBe("Fix the login page");
    expect(csvText(null)).toBe("");
    for (const lead of ["=", "+", "-", "@", "\t"])
      expect(csvText(`${lead}1+1`)).toBe(`'${lead}1+1`);
    // A carriage return also makes RFC 4180 quote the field.
    expect(csvText("\r1+1")).toBe('"\'\r1+1"');
    expect(csvText('=HYPERLINK("https://example.com"), click')).toBe(
      '"\'=HYPERLINK(""https://example.com""), click"',
    );
  });
});

describe("export_statement", () => {
  it("reads every level for the month in the caller's workspace", async () => {
    const h = harness([]);
    await h.handler(GROUPS, ctx());
    for (const level of ["operator", "agent", "model", "tool", "task"])
      expect(h.readDailyTotals).toHaveBeenCalledWith(SCOPE, {
        from: "2026-09-01",
        to: "2026-09-30",
        groupKind: level,
      });
  });

  it("answers the header alone for a month with no rollup", async () => {
    const h = harness([]);
    const out = await h.handler(GROUPS, ctx());
    expect(out).toEqual({
      month: "2026-09",
      filename: "spend-statement-2026-09.csv",
      mediaType: "text/csv",
      content: `${STATEMENT_COLUMNS.join(",")}\n`,
      lines: 0,
    });
    expect(() => spendStatementExport.output.parse(out)).not.toThrow();
  });

  it("writes one line per group with cents rounded half to even once, and blanks for what was never priced", async () => {
    const h = harness([
      daily({
        day: "2026-09-03",
        costMicros: 1_234_950n,
        costBasis: "client_attested",
        provenMicros: 500_000n,
        runs: 2,
        calls: 7,
      }),
      daily({
        day: "2026-09-04",
        costMicros: 0n,
        costBasis: "client_attested",
        runs: 1,
        calls: 1,
      }),
      daily({
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        provider: "anthropic",
        costMicros: 25_000n,
        costBasis: "gateway_observed",
      }),
      daily({ groupKind: "tool", groupKey: "Read, write", runs: 3, calls: 9 }),
      daily({ day: "2026-08-31", costMicros: 9n, costBasis: "estimated" }),
    ]);
    const out = await h.handler(GROUPS, ctx());
    const [header, ...lines] = out.content.trimEnd().split("\n");
    expect(header).toBe(STATEMENT_COLUMNS.join(","));
    expect(lines).toEqual([
      // 1,234,950 micros = 123.495 cents → 123 (half to even at the line).
      `operator,${OPERATOR},,3,8,1234950,123,USD,client_attested,500000,`,
      // 25,000 micros = 2.5 cents → 2.
      "model,claude-sonnet-5,anthropic,1,4,25000,2,USD,gateway_observed,,",
      'tool,"Read, write",,3,9,,,,,,',
    ]);
    expect(out.lines).toBe(3);
    expect(() => spendStatementExport.output.parse(out)).not.toThrow();
  });
});

describe("export_statement with one line per run (#2962)", () => {
  const PERSON: OperatorFacts = {
    id: OPERATOR,
    name: "Marcus Bell",
    email: "marcus@example.com",
    avatarUrl: null,
    role: "Member",
  };
  /** An operator key no user record names. */
  const NAMELESS = "prn_0000000000000000000nob";
  const SEND: RunWorkOrderRef = {
    workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
    workOrderKind: "send",
  };
  const ATTACHED: RunWorkOrderRef = {
    workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f2",
    workOrderKind: "direct",
  };
  /** A direct work order no person attached to a work item. */
  const LOOSE: RunWorkOrderRef = {
    workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f3",
    workOrderKind: "direct",
  };
  const ITEMS: [RunWorkOrderRef, RunWorkItem][] = [
    [
      SEND,
      {
        id: "wi_0000000000000000000001",
        number: "OPS-88",
        subject: "Fix the login page, again",
      },
    ],
    [
      ATTACHED,
      {
        id: "wi_0000000000000000000002",
        number: "OPS-90",
        subject: '=HYPERLINK("https://example.com"), click',
      },
    ],
  ];

  function month() {
    const sent = pricedRun(1_234_950n, { ...SEND });
    const open = run({
      operatorKey: null,
      operatorPrincipalId: null,
      startedAt: new Date("2026-09-11T08:00:00.000Z"),
      sealedAt: null,
      ...LOOSE,
    });
    const nameless = pricedRun(25_000n, {
      costBasis: "gateway_observed",
      operatorKey: NAMELESS,
      startedAt: new Date("2026-09-12T09:00:00.000Z"),
      sealedAt: new Date("2026-09-12T09:30:00.000Z"),
      ...ATTACHED,
    });
    const assistant = [
      { ...pricedRun(10_000n), inApp: true },
      { ...pricedRun(5_000n), inApp: true },
    ];
    return { sent, open, nameless, runs: [sent, open, nameless, ...assistant] };
  }

  it("answers the header alone for a month with no run", async () => {
    const h = harness([]);
    const out = await h.handler(RUNS, ctx());
    expect(out).toEqual({
      month: "2026-09",
      filename: "spend-runs-2026-09.csv",
      mediaType: "text/csv",
      content: `${RUN_STATEMENT_COLUMNS.join(",")}\n`,
      lines: 0,
    });
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(h.readDailyTotals).not.toHaveBeenCalled();
    expect(() => spendStatementExport.output.parse(out)).not.toThrow();
  });

  it("writes each run with its agent, operator, work item, and cost, and the assistant's runs on one line", async () => {
    const { sent, open, nameless, runs } = month();
    const h = harness([], runs, [PERSON], ITEMS);
    const out = await h.handler(RUNS, ctx());
    const [header, ...lines] = out.content.trimEnd().split("\n");
    expect(header).toBe(RUN_STATEMENT_COLUMNS.join(","));
    expect(lines).toEqual([
      // 1,234,950 micros = 123.495 cents → 123, rounded once on the line.
      `run,${sent.runId},2026-09-10T12:00:00.000Z,2026-09-10T12:30:00.000Z,acme.core.cc,${OPERATOR},Marcus Bell,OPS-88,"Fix the login page, again",1,1234950,123,USD,client_attested`,
      // Unpriced, open, no operator, and a direct work order nobody attached:
      // every one of those fields is empty, and no cost reads as 0.
      `run,${open.runId},2026-09-11T08:00:00.000Z,,acme.core.cc,,,,,1,,,,`,
      // A key nobody can name leaves the name empty rather than repeat the
      // key, and a title a spreadsheet would run stays text.
      `run,${nameless.runId},2026-09-12T09:00:00.000Z,2026-09-12T09:30:00.000Z,acme.core.cc,${NAMELESS},,OPS-90,"'=HYPERLINK(""https://example.com""), click",1,25000,2,USD,gateway_observed`,
      // ADR-235: the assistant's runs are one line that names no run.
      "assistant,,,,,,,,,2,15000,2,USD,client_attested",
    ]);
    expect(out.lines).toBe(4);
    expect(out.filename).toBe("spend-runs-2026-09.csv");
    expect(() => spendStatementExport.output.parse(out)).not.toThrow();
  });

  it("adds up to the month's total in micros", async () => {
    const { runs } = month();
    const h = harness([], runs, [PERSON], ITEMS);
    const out = await h.handler(RUNS, ctx());
    const lines = out.content.trimEnd().split("\n").slice(1);
    // cost_micros is the fourth field from the end, after any quoted title.
    const sum = lines.reduce((total, line) => {
      const micros = line.split(",").at(-4) ?? "";
      return micros === "" ? total : total + BigInt(micros);
    }, 0n);
    const total = runs.reduce(
      (all, r) => (r.costMicros === null ? all : all + r.costMicros),
      0n,
    );
    expect(sum).toBe(total);
  });

  it("asks who and what for the workspace's own runs only, in one read each", async () => {
    const { runs } = month();
    const h = harness([], runs, [PERSON], ITEMS);
    await h.handler(RUNS, ctx());
    expect(h.readOperatorFacts).toHaveBeenCalledTimes(1);
    expect(h.readOperatorFacts).toHaveBeenCalledWith(SCOPE, [
      OPERATOR,
      NAMELESS,
    ]);
    expect(h.readRunWorkItems).toHaveBeenCalledTimes(1);
    expect(h.readRunWorkItems).toHaveBeenCalledWith(SCOPE, [
      SEND,
      LOOSE,
      ATTACHED,
    ]);
  });

  it("keeps the statement the default", async () => {
    const { runs } = month();
    const h = harness([], runs, [PERSON], ITEMS);
    const out = await h.handler(
      spendStatementExport.input.parse({ month: "2026-09" }),
      ctx(),
    );
    expect(out.filename).toBe("spend-statement-2026-09.csv");
    expect(out.content).toBe(`${STATEMENT_COLUMNS.join(",")}\n`);
    expect(h.readRunTotals).not.toHaveBeenCalled();
  });
});
