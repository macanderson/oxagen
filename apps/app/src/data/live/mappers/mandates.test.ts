// The mandate mapper over real contract-output samples: a limit that names a
// currency is money in micros, one that names a unit is a count, the ratios
// the meter draws come from the ledger's own figures, and a limit with no
// per-period figure has neither a remaining nor a ratio.
import { describe, expect, it } from "vitest";
import { MandateList } from "@/data/contracts/mandates";
import {
  authorityOutput,
  callsAuthorityOutput,
  MANDATE_ID,
  mandateListOutput,
  mandateOutput,
} from "@/test/mandate-outputs";
import { toMandateList } from "./mandates";

const view = () => MandateList.parse(toMandateList(mandateListOutput()));

/** The one mandate of a one-mandate answer, and its first measure. */
function only(mandates: MandateList["mandates"]): MandateList["mandates"][number] {
  expect(mandates).toHaveLength(1);
  const [mandate] = mandates;
  if (mandate === undefined) throw new Error("no mandate");
  return mandate;
}

function firstMeasure(
  mandates: MandateList["mandates"],
): MandateList["mandates"][number]["authority"][number] {
  const [authority] = only(mandates).authority;
  if (authority === undefined) throw new Error("no authority");
  return authority;
}

describe("toMandateList", () => {
  it("keeps the grant: who asked, who granted, the role they held and the consequence", () => {
    expect(only(view().mandates)).toMatchObject({
      id: MANDATE_ID,
      agentId: "agt_invoicebot",
      agentSlug: "invoice-bot",
      requestedBy: "usr_marcusbell",
      grantedBy: "usr_priyanatarajan",
      roleAtGrant: "Billing",
      consequenceTags: ["moves_money"],
      tools: ["stripe__create_payment@*"],
      purpose: "monthly infrastructure invoices, PO-4471",
      status: "active",
    });
  });

  it("reads a currency limit as money in micros", () => {
    expect(firstMeasure(view().mandates)).toEqual({
      measure: "amount",
      period: "monthly",
      periodKey: "2026-09",
      perCall: { kind: "money", money: { micros: "250000000", currency: "USD" } },
      perPeriod: {
        kind: "money",
        money: { micros: "2000000000", currency: "USD" },
      },
      settled: {
        kind: "money",
        money: { micros: "1204180000", currency: "USD" },
      },
      reserved: {
        kind: "money",
        money: { micros: "180000000", currency: "USD" },
      },
      remaining: {
        kind: "money",
        money: { micros: "615820000", currency: "USD" },
      },
      settledRatio: 0.60209,
      reservedRatio: 0.09,
    });
  });

  it("reads a limit that names a unit as a count in that unit", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({ authority: [callsAuthorityOutput()] }),
        ]),
      ),
    );
    expect(firstMeasure(view.mandates)).toMatchObject({
      measure: "calls",
      perCall: null,
      perPeriod: { kind: "count", count: 50, unit: "calls" },
      settled: { kind: "count", count: 11, unit: "calls" },
      reserved: { kind: "count", count: 1, unit: "calls" },
      remaining: { kind: "count", count: 38, unit: "calls" },
      settledRatio: 0.22,
      reservedRatio: 0.02,
    });
  });

  it("gives a limit with no per-period figure no remaining and no ratio (negative)", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            authority: [
              authorityOutput({ perPeriod: null, remaining: null }),
            ],
          }),
        ]),
      ),
    );
    expect(firstMeasure(view.mandates)).toMatchObject({
      perPeriod: null,
      remaining: null,
      settledRatio: null,
      reservedRatio: null,
    });
  });

  it("keeps a request nobody has granted without inventing a granter (negative)", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            status: "draft",
            grantedBy: null,
            roleAtGrant: null,
          }),
        ]),
      ),
    );
    expect(only(view.mandates)).toMatchObject({
      status: "draft",
      grantedBy: null,
      roleAtGrant: null,
    });
  });

  it("carries a mandate with no draw at all as zero settled and zero reserved", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            authority: [
              authorityOutput({
                settled: "0",
                reserved: "0",
                remaining: "2000000000",
              }),
            ],
          }),
        ]),
      ),
    );
    expect(firstMeasure(view.mandates)).toMatchObject({
      settledRatio: 0,
      reservedRatio: 0,
      remaining: {
        kind: "money",
        money: { micros: "2000000000", currency: "USD" },
      },
    });
  });

  it("answers an empty workspace with no mandates", () => {
    expect(MandateList.parse(toMandateList(mandateListOutput([])))).toEqual({
      mandates: [],
    });
  });
});
