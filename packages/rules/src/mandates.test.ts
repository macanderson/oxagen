/**
 * `parseMandateRow`'s measure-kind resolution (ADR-108), unit-level: a pure
 * function over a plain row object, no database. The Postgres-integration
 * suite (`mandates.pg.test.ts`) proves `readAuthority` and the ledger against
 * a real store; this file is about the one thing that needs no store: a
 * legacy row with no stored `kind` takes the documented fallback, and a row
 * written since ADR-108 keeps its real one.
 */
import { describe, expect, it } from "vitest";
import { parseMandateRow } from "./mandates";

const BASE_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  publicId: "mnd_1",
  orgId: "org_1",
  workspaceId: "ws_1",
  agentPrincipalId: "prn_1",
  consequenceTags: ["moves_money"],
  targets: {},
  tools: ["stripe__create_payment@*"],
  approvalRules: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
  status: "active",
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: new Date("2027-01-01T00:00:00.000Z"),
} as const;

// `typeof m.$inferSelect` carries every column of `tools.mandates`;
// `parseMandateRow` reads only the ones above and `limits`, so the double
// cast (through `unknown`) covers the columns this test does not otherwise
// care about, the same way a store double does for a handler test.
type Row = Parameters<typeof parseMandateRow>[0];
const row = (limits: unknown): Row =>
  ({ ...BASE_ROW, limits }) as unknown as Row;

describe("parseMandateRow, kind resolution (ADR-108)", () => {
  it("keeps a stored kind unchanged", () => {
    const record = parseMandateRow(
      row({
        amount: {
          perPeriod: "500000000",
          period: "monthly",
          currencyOrUnit: "USD",
          kind: "count",
        },
      }),
    );
    // Stored kind wins even though `currencyOrUnit` looks like money, proof
    // this reads the fact and never re-derives it from the unit string.
    expect(record.limits.amount?.kind).toBe("count");
  });

  it("fills a legacy row's missing kind from the documented fallback", () => {
    const record = parseMandateRow(
      row({
        amount: {
          perPeriod: "500000000",
          period: "monthly",
          currencyOrUnit: "USD",
        },
        rows: { perPeriod: "1000", period: "daily", currencyOrUnit: "GAU" },
      }),
    );
    expect(record.limits.amount?.kind).toBe("money");
    expect(record.limits.rows?.kind).toBe("count");
  });

  it("resolves every measure's kind independently in one mandate", () => {
    const record = parseMandateRow(
      row({
        amount: {
          perPeriod: "500000000",
          period: "monthly",
          currencyOrUnit: "USD",
          kind: "money",
        },
        calls: {
          perPeriod: "250000000",
          period: "monthly",
          currencyOrUnit: "calls",
        },
      }),
    );
    expect(record.limits.amount?.kind).toBe("money");
    expect(record.limits.calls?.kind).toBe("count");
  });
});
