/**
 * `assertToolsDeclareMeasures`'s measure-kind stamping (ADR-108), unit-level:
 * no database, a fake `tx` whose `select().from().innerJoin().where()` chain
 * resolves to the declared-tool rows the test names. The declared-measure and
 * unit checks already have Postgres-integration coverage
 * (`mandate.handlers.pg.test.ts`); this file is about the one thing that
 * needs no store: what `kind` ends up on the limits this function returns,
 * and the one case it must refuse rather than guess.
 */
import { describe, expect, it } from "vitest";
import type { Tx } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";
import type {
  MandateLimits,
  MandateTargets,
} from "@oxagen/oxagen/mandates/schemas";
import { assertToolsDeclareMeasures } from "./_mandate";

interface DeclaredRow {
  slug: string;
  version: number;
  measures: Record<string, { path: string; type: string; unit: string }>;
  consequenceTags: string[];
  classification: null;
}

/** A `tx` whose declared-tools query answers exactly `rows`, nothing else touched. */
function fakeTx(rows: DeclaredRow[]): Tx {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => rows,
        }),
      }),
    }),
  } as unknown as Tx;
}

const WORKSPACE_ID = "ws_1";

const PAYMENT_TOOL: DeclaredRow = {
  slug: "stripe__create_payment",
  version: 1,
  measures: {
    amount: { path: "amount.value", type: "amount", unit: "USD" },
  },
  consequenceTags: ["moves_money"],
  classification: null,
};

describe("assertToolsDeclareMeasures, kind (ADR-108)", () => {
  it("stamps money for a declared amount measure", async () => {
    const limits: MandateLimits = {
      amount: {
        perPeriod: "500000000",
        period: "monthly",
        currencyOrUnit: "USD",
      },
    };
    const out = await assertToolsDeclareMeasures(
      fakeTx([PAYMENT_TOOL]),
      WORKSPACE_ID,
      {
        tools: ["stripe__create_payment@*"],
        limits,
        targets: {} as MandateTargets,
      },
    );
    expect(out.amount).toEqual({
      perPeriod: "500000000",
      period: "monthly",
      currencyOrUnit: "USD",
      kind: "money",
    });
  });

  it("stamps count for a declared count measure denominated in a currency code, the exact case a guess from the unit gets wrong", async () => {
    // A tool may legitimately declare a count in a currency-code unit. The
    // handler accepts it (the unit check compares against the declaration,
    // not against `isCurrencyCode`), and the stamped kind must be `count`,
    // not `money`, or #3130 reopens.
    const countInCurrencyUnit: DeclaredRow = {
      slug: "billing__batch",
      version: 1,
      measures: {
        batch_size: { path: "batchSize", type: "count", unit: "USD" },
      },
      consequenceTags: ["moves_money"],
      classification: null,
    };
    const limits: MandateLimits = {
      batch_size: { perPeriod: "50", period: "daily", currencyOrUnit: "USD" },
    };
    const out = await assertToolsDeclareMeasures(
      fakeTx([countInCurrencyUnit]),
      WORKSPACE_ID,
      { tools: ["billing__batch@*"], limits, targets: {} as MandateTargets },
    );
    expect(out.batch_size).toEqual({
      perPeriod: "50",
      period: "daily",
      currencyOrUnit: "USD",
      kind: "count",
    });
  });

  it("stamps count for the built-in calls measure with no declaration", async () => {
    const limits: MandateLimits = {
      calls: {
        perPeriod: "250000000",
        period: "monthly",
        currencyOrUnit: "calls",
      },
    };
    const out = await assertToolsDeclareMeasures(
      fakeTx([PAYMENT_TOOL]),
      WORKSPACE_ID,
      {
        tools: ["stripe__create_payment@*"],
        limits,
        targets: {} as MandateTargets,
      },
    );
    expect(out.calls).toEqual({
      perPeriod: "250000000",
      period: "monthly",
      currencyOrUnit: "calls",
      kind: "count",
    });
  });

  it("stamps every measure a mandate limits, independently, when one tool declares them all", async () => {
    const both: DeclaredRow = {
      slug: "billing__mixed",
      version: 1,
      measures: {
        amount: { path: "amount", type: "amount", unit: "USD" },
        rows: { path: "rowCount", type: "count", unit: "rows" },
      },
      consequenceTags: ["moves_money"],
      classification: null,
    };
    const limits: MandateLimits = {
      amount: { perCall: "100000000", period: "daily", currencyOrUnit: "USD" },
      rows: { perPeriod: "1000", period: "daily", currencyOrUnit: "rows" },
    };
    const out = await assertToolsDeclareMeasures(fakeTx([both]), WORKSPACE_ID, {
      tools: ["billing__mixed@*"],
      limits,
      targets: {} as MandateTargets,
    });
    expect(out.amount?.kind).toBe("money");
    expect(out.rows?.kind).toBe("count");
  });

  it("refuses measure_kind_conflict when two matched tools declare the same measure with different kinds", async () => {
    // Same measure name, same unit (so the existing unit check cannot catch
    // it), different `type`. Write time is the only moment that can see
    // both, per ADR-108.
    const amountAsCount: DeclaredRow = {
      slug: "storage__deposit",
      version: 1,
      measures: {
        amount: { path: "amount", type: "count", unit: "USD" },
      },
      consequenceTags: ["moves_money"],
      classification: null,
    };
    const limits: MandateLimits = {
      amount: {
        perPeriod: "500000000",
        period: "monthly",
        currencyOrUnit: "USD",
      },
    };
    await expect(
      assertToolsDeclareMeasures(
        fakeTx([PAYMENT_TOOL, amountAsCount]),
        WORKSPACE_ID,
        {
          tools: ["*"],
          limits,
          targets: {} as MandateTargets,
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isHandlerError(err) && err.reason === "measure_kind_conflict",
    );
  });
});
