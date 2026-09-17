// Typed mandate view values for the component tests of the three surfaces that
// show a mandate (ARCHITECTURE.md §5): the Tools ledger, the Agents section and
// the bar on a Fleet approval card. It lives here rather than in a feature's
// builders because three features read it and no feature may reach into
// another's folder. Test support only: src/test is never in a production
// bundle.
//
// Values only, no DataSource. The ledger became a tab on the #2958 Tools page,
// so its tests render through that page's own `toolsSource`
// (`features/tools/tools.builders.ts`), which answers every Tools read
// including this one. A second stub of the same seam is a second place for it
// to fall behind `DataSource` — which is exactly what happened while the two
// lanes were apart.
import type { MandateList, MandateRow } from "@/data/contracts/mandates";
import { type Read, readOk } from "@/data/read";

const money = (micros: string) =>
  ({ kind: "money", money: { micros, currency: "USD" } }) as const;

export function mandateAuthority(
  overrides: Partial<MandateRow["authority"][number]> = {},
): MandateRow["authority"][number] {
  return {
    measure: "amount",
    period: "monthly",
    periodKey: "2026-09",
    perCall: money("250000000"),
    perPeriod: money("2000000000"),
    settled: money("1204180000"),
    reserved: money("180000000"),
    remaining: money("615820000"),
    settledRatio: 0.60209,
    reservedRatio: 0.09,
    overLimit: false,
    ...overrides,
  };
}

export function mandateRow(overrides: Partial<MandateRow> = {}): MandateRow {
  return {
    id: "mnd_4f2a9c",
    agentId: "agt_invoicebot",
    agentSlug: "invoice-bot",
    requestedBy: "usr_marcusbell",
    grantedBy: "usr_priyanatarajan",
    roleAtGrant: "Billing",
    consequenceTags: ["moves_money"],
    tools: ["stripe__create_payment@*"],
    purpose: "monthly infrastructure invoices, PO-4471",
    validFrom: "2026-09-01T00:00:00.000Z",
    validTo: "2026-12-31T00:00:00.000Z",
    status: "active",
    authority: [mandateAuthority()],
    ...overrides,
  };
}

export function mandateList(
  mandates: MandateRow[],
  truncatedAt: number | null = null,
  asOf = "2026-09-16T12:00:00.000Z",
): Read<MandateList> {
  return readOk({ mandates, truncatedAt, asOf });
}

/** The built-in `calls` limit, a count measure beside an amount. */
export function callsAuthority(): MandateRow["authority"][number] {
  return mandateAuthority({
    measure: "calls",
    period: "daily",
    periodKey: "2026-09-16",
    perCall: null,
    perPeriod: { kind: "count", count: "50", unit: "calls" },
    settled: { kind: "count", count: "11", unit: "calls" },
    reserved: { kind: "count", count: "1", unit: "calls" },
    remaining: { kind: "count", count: "38", unit: "calls" },
    settledRatio: 0.22,
    reservedRatio: 0.02,
  });
}
