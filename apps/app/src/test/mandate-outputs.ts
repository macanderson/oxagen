// Contract-output samples for the mandate mapper, adapter and section tests
// (ARCHITECTURE.md §5): what list_mandates answers for a workspace with one
// active mandate on an invoice agent — a monthly amount in USD with a
// reservation held against it, and the built-in calls measure beside it. Test
// support only: src/test is never in a production bundle.
import type { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import type { ContractOutput } from "@/server/kernel";

type MandatesOutput = ContractOutput<typeof mandateList>;
type MandateOutput = MandatesOutput["items"][number];
type AuthorityOutput = MandateOutput["authority"][number];

export const MANDATE_ID = "mnd_4f2a9c";
const AT = "2026-09-01T00:00:00.000Z";

export function authorityOutput(
  overrides: Partial<AuthorityOutput> = {},
): AuthorityOutput {
  return {
    measure: "amount",
    currencyOrUnit: "USD",
    period: "monthly",
    periodKey: "2026-09",
    perCall: "250000000",
    perPeriod: "2000000000",
    settled: "1204180000",
    reserved: "180000000",
    remaining: "615820000",
    ...overrides,
  };
}

/** The built-in count measure: every call draws one, and the unit is its own name. */
export function callsAuthorityOutput(
  overrides: Partial<AuthorityOutput> = {},
): AuthorityOutput {
  return {
    measure: "calls",
    currencyOrUnit: "calls",
    period: "daily",
    periodKey: "2026-09-16",
    perCall: null,
    perPeriod: "50",
    settled: "11",
    reserved: "1",
    remaining: "38",
    ...overrides,
  };
}

export function mandateOutput(
  overrides: Partial<MandateOutput> = {},
): MandateOutput {
  return {
    id: MANDATE_ID,
    agentId: "agt_invoicebot",
    agentSlug: "invoice-bot",
    requestedBy: "usr_marcusbell",
    grantedBy: "usr_priyanatarajan",
    roleAtGrant: "Billing",
    consequenceTags: ["moves_money"],
    limits: {
      amount: {
        perCall: "250000000",
        perPeriod: "2000000000",
        period: "monthly",
        currencyOrUnit: "USD",
      },
    },
    targets: {},
    tools: ["stripe__create_payment@*"],
    approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
    purpose: "monthly infrastructure invoices, PO-4471",
    validFrom: AT,
    validTo: "2026-12-31T00:00:00.000Z",
    status: "active",
    revokedBy: null,
    revokedReason: null,
    revokedAt: null,
    createdAt: AT,
    updatedAt: AT,
    authority: [authorityOutput()],
    ...overrides,
  };
}

export function mandateListOutput(
  items: MandateOutput[] = [mandateOutput()],
): MandatesOutput {
  return { items };
}
