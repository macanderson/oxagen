/**
 * The mandate of MC spec §6.9 part 3, in the contract's wire shape, for the
 * contract and handler tests. Not a fixture the product reads.
 */
export const SPEC_MANDATE_BODY = {
  agentId: "agt_0123456789abcdefghjkmn",
  consequenceTags: ["moves_money"],
  limits: {
    amount: {
      perCall: "250000000",
      perPeriod: "2000000000",
      period: "monthly",
      currencyOrUnit: "USD",
    },
    calls: { perPeriod: "50", period: "daily", currencyOrUnit: "calls" },
  },
  targets: {
    counterparty: { allow: ["vendor:aws", "vendor:github"], deny: ["*"] },
  },
  tools: ["stripe__create_payment@*"],
  approval: {
    humanAbove: { amount: "100000000" },
    alwaysHumanFor: ["destroys_data"],
    approvers: ["role:Billing"],
  },
  purpose: "monthly infrastructure invoices, PO-4471",
  validFrom: "2026-09-01T00:00:00Z",
  validTo: "2026-12-31T23:59:59Z",
};
