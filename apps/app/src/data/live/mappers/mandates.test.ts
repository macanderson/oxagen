// The mandate mapper over real contract-output samples: a limit that names a
// currency is money in micros, one that names a unit is a count, the ratios
// the meter draws come from the ledger's own figures, and a limit with no
// per-period figure has neither a remaining nor a ratio.
import { describe, expect, it } from "vitest";
import { MandateDetail, MandateList } from "@/data/contracts/mandates";
import {
  authorityOutput,
  callsAuthorityOutput,
  ledgerOutput,
  MANDATE_ID,
  mandateGetOutput,
  mandateListOutput,
  mandateOutput,
} from "@/test/mandate-outputs";
import { toMandateDetail, toMandateList } from "./mandates";

const view = () => MandateList.parse(toMandateList(mandateListOutput(), 100));

/** The one mandate of a one-mandate answer, and its first measure. */
function only(
  mandates: MandateList["mandates"],
): MandateList["mandates"][number] {
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
      perCall: {
        kind: "money",
        money: { micros: "250000000", currency: "USD" },
      },
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
      overLimit: false,
    });
  });

  it("reads a limit that names a unit as a count in that unit", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({ authority: [callsAuthorityOutput()] }),
        ]),
        100,
      ),
    );
    expect(firstMeasure(view.mandates)).toMatchObject({
      measure: "calls",
      perCall: null,
      perPeriod: { kind: "count", count: "50", unit: "calls" },
      settled: { kind: "count", count: "11", unit: "calls" },
      reserved: { kind: "count", count: "1", unit: "calls" },
      remaining: { kind: "count", count: "38", unit: "calls" },
      settledRatio: 0.22,
      reservedRatio: 0.02,
    });
  });

  it("gives a limit with no per-period figure no remaining and no ratio (negative)", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            authority: [authorityOutput({ perPeriod: null, remaining: null })],
          }),
        ]),
        100,
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
        100,
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
        100,
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

  // #3448 (residue from #3442, ADR-111): a non-ISO-4217 unit on an `amount`
  // measure used to reach here from `measures.<name>.unit` (up to 32
  // characters, no ISO check) whenever a mandate's limit named it, and
  // `moneyFromMicros` built a `Money` value the schema then refused, taking
  // every mandate naming the measure down with `record_unmappable`. ADR-111
  // closes this at `measureDeclarationSchema`, the one write boundary every
  // tool declaration passes through, so a money-kind authority reaching this
  // mapper is now guaranteed an ISO 4217 `currencyOrUnit` by construction.
  // This asserts that guarantee holds through the mapper and `Money`'s
  // schema, rather than merely being untested.
  it("maps a money-kind authority's currency to a Money value that parses (ADR-111)", () => {
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            authority: [authorityOutput({ currencyOrUnit: "USD" })],
          }),
        ]),
        100,
      ),
    );
    const measure = firstMeasure(view.mandates);
    expect(measure.settled).toEqual({
      kind: "money",
      money: { micros: "1204180000", currency: "USD" },
    });
  });

  it("reads a three-letter unit that is no currency as a count (negative)", () => {
    // GAU is what this product bills in, and RPM is a rate: both are
    // well-formed three-letter units, and neither is an ISO 4217 code.
    for (const unit of ["GAU", "RPM"]) {
      const view = MandateList.parse(
        toMandateList(
          mandateListOutput([
            mandateOutput({
              authority: [
                callsAuthorityOutput({
                  measure: "units",
                  currencyOrUnit: unit,
                }),
              ],
            }),
          ]),
          100,
        ),
      );
      expect(firstMeasure(view.mandates).perPeriod).toEqual({
        kind: "count",
        count: "50",
        unit,
      });
    }
  });

  it("reads a declared count denominated in a currency code as a count, not money (#3130, ADR-108)", () => {
    // A tool may legitimately declare `{ type: "count", unit: "USD" }`. Before
    // ADR-108 the mapper guessed from `currencyOrUnit` alone (`isCurrencyCode`)
    // and read this whole-unit count of 50 as 50 micros of a dollar ($0.00)
    // while the gate enforced 50 counted units. The mapper now switches on the
    // stored `kind`, which is `count` here despite `currencyOrUnit` being
    // "USD".
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            authority: [
              callsAuthorityOutput({
                measure: "batch_size",
                currencyOrUnit: "USD",
                kind: "count",
              }),
            ],
          }),
        ]),
        100,
      ),
    );
    expect(firstMeasure(view.mandates).perPeriod).toEqual({
      kind: "count",
      count: "50",
      unit: "USD",
    });
  });

  it("keeps a count larger than a double holds exactly", () => {
    const huge = "9007199254740993";
    const view = MandateList.parse(
      toMandateList(
        mandateListOutput([
          mandateOutput({
            authority: [
              callsAuthorityOutput({
                perPeriod: huge,
                settled: huge,
                remaining: "0",
              }),
            ],
          }),
        ]),
        100,
      ),
    );
    const authority = firstMeasure(view.mandates);
    expect(authority.perPeriod).toMatchObject({ count: huge });
    expect(authority.settled).toMatchObject({ count: huge });
    expect(authority.settledRatio).toBe(1);
  });

  it("says the answer filled the page it asked for, and nothing when it did not", () => {
    const one = mandateListOutput();
    expect(MandateList.parse(toMandateList(one, 1)).truncatedAt).toBe(1);
    expect(MandateList.parse(toMandateList(one, 100)).truncatedAt).toBeNull();
  });

  it("answers an empty workspace with no mandates", () => {
    const at = new Date("2026-09-16T12:00:00.000Z");
    expect(
      MandateList.parse(toMandateList(mandateListOutput([]), 100, at)),
    ).toEqual({
      mandates: [],
      truncatedAt: null,
      asOf: "2026-09-16T12:00:00.000Z",
    });
  });
});

describe("toMandateList asOf", () => {
  // Whether a mandate is in effect is a question about an instant, and the
  // page may not ask a clock during render, so the answer carries the instant
  // it was read at.
  it("stamps the instant the ledger answered", () => {
    const at = new Date("2026-03-04T05:06:07.008Z");
    expect(toMandateList(mandateListOutput([]), 100, at).asOf).toBe(
      "2026-03-04T05:06:07.008Z",
    );
  });

  it("defaults to now when no instant is given", () => {
    const before = Date.now();
    const asOf = Date.parse(toMandateList(mandateListOutput([]), 100).asOf);
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now());
  });
});

describe("toMandateList overLimit", () => {
  const of = (settled: string, reserved: string, perPeriod: string | null) =>
    firstMeasure(
      MandateList.parse(
        toMandateList(
          mandateListOutput([
            mandateOutput({
              authority: [
                authorityOutput({
                  settled,
                  reserved,
                  perPeriod,
                  remaining: null,
                }),
              ],
            }),
          ]),
          100,
        ),
      ).mandates,
    );

  // `update_mandate_limits` may lower a limit under authority already drawn.
  // The ratios cannot carry this: both clamp to 1.
  it("marks an excess carried by settlement alone", () => {
    const measure = of("600000000", "0", "500000000");
    expect(measure.overLimit).toBe(true);
    expect(measure.settledRatio).toBe(1);
    expect(measure.reservedRatio).toBe(0);
  });

  it("marks an excess carried by the two together", () => {
    expect(of("500000000", "500000000", "500000000").overLimit).toBe(true);
  });

  it("marks a limit drawn exactly to its edge as within it (negative)", () => {
    const measure = of("500000000", "0", "500000000");
    expect(measure.overLimit).toBe(false);
    expect(measure.settledRatio).toBe(1);
  });

  it("marks a measure with no per-period limit as not over it (negative)", () => {
    expect(of("600000000", "600000000", null).overLimit).toBe(false);
  });
});

describe("toMandateList grant scope", () => {
  const one = (overrides: Parameters<typeof mandateOutput>[0]) =>
    only(
      MandateList.parse(
        toMandateList(mandateListOutput([mandateOutput(overrides)]), 100),
      ).mandates,
    );

  it("carries the counterparty rules as a list, keyed by the measure they bound", () => {
    expect(
      one({
        targets: {
          amount: { allow: ["vendor:aws"], deny: ["*"] },
        },
      }).targets,
    ).toEqual([{ measure: "amount", allow: ["vendor:aws"], deny: ["*"] }]);
  });

  it("carries no counterparty rule when the grant named none", () => {
    expect(one({ targets: {} }).targets).toEqual([]);
  });

  // `humanAbove` names a measure and an integer and no unit at all, so the only
  // evidence for the form is the limit on the same measure.
  it("prints an approval threshold in the form the mandate's own limit establishes", () => {
    const approval = one({
      approval: {
        humanAbove: { amount: "100000000" },
        alwaysHumanFor: ["moves_money"],
        approvers: ["role:Billing"],
      },
    }).approval;
    expect(approval.humanAbove).toEqual([
      {
        measure: "amount",
        value: {
          kind: "money",
          money: { micros: "100000000", currency: "USD" },
        },
        recorded: "100000000",
      },
    ]);
    expect(approval.alwaysHumanFor).toEqual(["moves_money"]);
    expect(approval.approvers).toEqual(["role:Billing"]);
  });

  it("prints an approval threshold in a count's form, from the limit's kind rather than a guess", () => {
    const approval = one({
      limits: {
        rows: {
          perPeriod: "1000",
          period: "daily",
          currencyOrUnit: "rows",
          kind: "count",
        },
      },
      authority: [
        authorityOutput({
          measure: "rows",
          currencyOrUnit: "rows",
          kind: "count",
          perPeriod: "1000",
        }),
      ],
      approval: {
        humanAbove: { rows: "25" },
        alwaysHumanFor: [],
        approvers: [],
      },
    }).approval;
    expect(approval.humanAbove).toEqual([
      {
        measure: "rows",
        value: { kind: "count", count: "25", unit: "rows" },
        recorded: "25",
      },
    ]);
  });

  it("leaves a threshold on an unlimited measure without a form rather than guessing one (negative)", () => {
    const [threshold] = one({
      approval: {
        humanAbove: { rows: "25" },
        alwaysHumanFor: [],
        approvers: [],
      },
    }).approval.humanAbove;
    expect(threshold).toEqual({
      measure: "rows",
      value: null,
      recorded: "25",
    });
  });
});

describe("toMandateDetail", () => {
  const detail = (
    ledger = [ledgerOutput()],
    ledgerLimit = 500,
    mandate = mandateOutput(),
  ) =>
    MandateDetail.parse(
      toMandateDetail(mandateGetOutput(ledger, mandate), ledgerLimit),
    );

  it("maps the mandate through the same row mapper the ledger tables read", () => {
    expect(detail().mandate).toMatchObject({
      id: MANDATE_ID,
      agentSlug: "invoice-bot",
      status: "active",
    });
  });

  it("keeps each draw's measure, figure, state, external effect and window", () => {
    const [row] = detail().draws;
    expect(row).toEqual({
      state: "settle",
      measure: "amount",
      value: {
        kind: "money",
        money: { micros: "884600000", currency: "USD" },
      },
      externalEffectRef: "pi_3QaL8f2Xk",
      periodKey: "2026-09",
      at: "2026-09-04T08:40:19.000Z",
    });
  });

  // INV-11: the ledger row's `id` and `toolCallId` are raw database uuids, and
  // the view model admits neither. A regression here would put a uuid on screen.
  it("carries no identifier out of the ledger row (negative)", () => {
    const [row] = detail().draws;
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("toolCallId");
    expect(JSON.stringify(row)).not.toContain("0199a0d4");
  });

  it("reads a count movement in whole units of its own measure", () => {
    const [row] = detail(
      [
        ledgerOutput({
          kind: "reserve",
          measure: "calls",
          value: "1",
          unitOrCurrency: "calls",
          externalEffectId: null,
        }),
      ],
      500,
      // A ledger row's kind is read from the mandate's own `authority` for
      // that measure (ADR-108), so the fixture must limit `calls` too, not
      // only `amount`.
      mandateOutput({ authority: [authorityOutput(), callsAuthorityOutput()] }),
    ).draws;
    expect(row).toMatchObject({
      state: "reserve",
      value: { kind: "count", count: "1", unit: "calls" },
      externalEffectRef: null,
    });
  });

  it("reads a row's own stamped kind ahead of the measure's current authority (ADR-108)", () => {
    // The row says "count"; the mandate's live authority for "amount" says
    // "money" (the fixture default). A row this old-format-honest should
    // never lose to a limit that has since changed underneath it, which is
    // exactly the whole-record `limits` replacement this column exists to
    // survive.
    const [row] = detail([
      ledgerOutput({ measureKind: "count", unitOrCurrency: "seats" }),
    ]).draws;
    expect(row).toMatchObject({
      value: { kind: "count", count: "884600000", unit: "seats" },
    });
  });

  it("falls back to the measure's current authority, then the legacy guess, when the row carries no stamped kind (negative)", () => {
    // No stamped kind and no authority for "amount" left (the whole-record
    // replacement this column exists to survive): the last resort is the
    // same currency-code guess a pre-ADR-108 row without a stored kind takes.
    const [row] = detail(
      [ledgerOutput({ measureKind: null })],
      500,
      mandateOutput({ authority: [] }),
    ).draws;
    expect(row).toMatchObject({
      value: { kind: "money", money: { currency: "USD" } },
    });
  });

  // A call's reservation and the settlement or release that closes it are one
  // draw. Listed as movements, a settled call read as two rows and kept a
  // `reserved` badge on money that had since settled.
  it("folds a call's reservation and its settlement into one settled draw", () => {
    const call = "0199a0d4-0000-7000-8000-0000000000b2";
    const draws = detail([
      ledgerOutput({
        id: "0199a0d4-0000-7000-8000-000000000003",
        toolCallId: call,
        kind: "settle",
        at: "2026-09-04T08:40:19.000Z",
      }),
      ledgerOutput({
        id: "0199a0d4-0000-7000-8000-000000000002",
        toolCallId: call,
        kind: "reserve",
        externalEffectId: null,
        at: "2026-09-04T08:40:11.000Z",
      }),
    ]).draws;
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({
      state: "settle",
      externalEffectRef: "pi_3QaL8f2Xk",
      at: "2026-09-04T08:40:19.000Z",
    });
  });

  it("reads a released call as released, and an open one as reserved", () => {
    const draws = detail([
      ledgerOutput({
        toolCallId: "0199a0d4-0000-7000-8000-0000000000c1",
        kind: "reserve",
        externalEffectId: null,
        at: "2026-09-11T09:31:08.000Z",
      }),
      ledgerOutput({
        toolCallId: "0199a0d4-0000-7000-8000-0000000000c2",
        kind: "release",
        externalEffectId: null,
        at: "2026-09-01T10:00:05.000Z",
      }),
      ledgerOutput({
        toolCallId: "0199a0d4-0000-7000-8000-0000000000c2",
        kind: "reserve",
        externalEffectId: null,
        at: "2026-09-01T10:00:00.000Z",
      }),
    ]).draws;
    expect(draws.map((d) => d.state)).toEqual(["reserve", "release"]);
    expect(draws[1]?.at).toBe("2026-09-01T10:00:05.000Z");
  });

  it("keeps one call's draws on two measures apart", () => {
    const draws = detail(
      [
        ledgerOutput({ kind: "reserve", externalEffectId: null }),
        ledgerOutput({
          kind: "reserve",
          measure: "calls",
          value: "1",
          unitOrCurrency: "calls",
          externalEffectId: null,
        }),
      ],
      500,
      mandateOutput({ authority: [authorityOutput(), callsAuthorityOutput()] }),
    ).draws;
    expect(draws.map((d) => d.measure)).toEqual(["amount", "calls"]);
  });

  // `readBound` is what the read can establish and nothing more. A ledger of
  // exactly the bound is indistinguishable from one of the bound plus a thousand,
  // and `get_mandate` answers no total, no has-more flag and no cursor — so the
  // field records the bound the answer filled, and the copy above the table says
  // it cannot tell whether there is more rather than claiming truncation.
  it("records the bound the answer filled, and nothing when it came back short", () => {
    expect(detail([ledgerOutput()], 1).readBound).toBe(1);
    expect(detail([ledgerOutput()], 500).readBound).toBeNull();
  });

  it("stamps the answer with the instant it was mapped", () => {
    const at = new Date("2026-09-16T12:00:00.000Z");
    expect(toMandateDetail(mandateGetOutput(), 500, at).asOf).toBe(
      at.toISOString(),
    );
  });
});

describe("toMandateDetail, an empty recorded effect id", () => {
  it("reads as nothing recorded rather than failing the whole page", () => {
    // `packages/rules/src/mandates.ts` stores whatever the tool's configured
    // effect-id path returned, an empty string included, and `get_mandate`
    // answers it unchanged. The view model wants a non-empty string or null, so
    // before this the page answered `record_unmappable` over one settlement.
    const detail = toMandateDetail(
      mandateGetOutput([ledgerOutput({ externalEffectId: "" })]),
      500,
      new Date("2026-09-19T00:00:00.000Z"),
    );
    expect(detail.draws[0]?.externalEffectRef).toBeNull();
    expect(MandateDetail.safeParse(detail).success).toBe(true);
  });
});
