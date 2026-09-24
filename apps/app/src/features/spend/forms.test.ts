/**
 * The Spend page's form parsers read directly: the budget ceiling, the
 * statement month, the finding id, and the price book's two writes.
 *
 * The dialogs and actions exercise these on their happy paths. These tests
 * pin each refusal to the field it names, because the field is what a person
 * sees highlighted, and the shapes each parser hands its contract, because a
 * key sent where it should be omitted changes what the write does (an empty
 * alias list replaces the stored one; a missing instant means "now").
 * `GatewayPolicyForm` has its own file, `gateway-form.test.ts`; the one case
 * here is the explicit permit-no-models control that file does not reach.
 */
import { describe, expect, it } from "vitest";
import {
  BudgetForm,
  budgetFieldErrors,
  GatewayPolicyForm,
  isFindingId,
  isStatementMonth,
  PriceEntryForm,
  priceFieldErrors,
  RemovePriceEntryForm,
} from "./forms";

/** The first issue's path head and message, or null when the parse succeeded. */
function refusal(
  parsed:
    | { success: true }
    | {
        success: false;
        error: {
          issues: readonly {
            path: readonly PropertyKey[];
            message: string;
          }[];
        };
      },
): { field: string; message: string } | null {
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  return {
    field: String(first?.path[0] ?? ""),
    message: first?.message ?? "",
  };
}

describe("BudgetForm", () => {
  const monthly = {
    scope: "workspace" as const,
    period: "monthly" as const,
    windowDays: "",
    limit: "250.5",
    enabled: true,
  };

  it("reads a monthly ceiling in dollars as micro-USD and sends no window", () => {
    expect(BudgetForm.parse(monthly)).toEqual({
      scope: "workspace",
      enabled: true,
      period: "monthly",
      limit: { micros: "250500000", currency: "USD" },
    });
  });

  it("reads a rolling ceiling's window as a number of days", () => {
    expect(
      BudgetForm.parse({ ...monthly, period: "rolling", windowDays: " 30 " }),
    ).toEqual({
      scope: "workspace",
      enabled: true,
      period: "rolling",
      windowDays: 30,
      limit: { micros: "250500000", currency: "USD" },
    });
  });

  it("ignores the window box on a monthly ceiling, whatever it holds", () => {
    expect(
      BudgetForm.safeParse({ ...monthly, windowDays: "not a number" }).success,
    ).toBe(true);
  });

  it("refuses a limit that is not a dollar amount, or is zero (negative)", () => {
    for (const limit of ["", "ten", "-5", "1.1234567", "0", "0.000000"]) {
      expect(refusal(BudgetForm.safeParse({ ...monthly, limit }))).toEqual({
        field: "limit",
        message: "limitInvalid",
      });
    }
  });

  it("refuses a rolling window that is not one to four digits without a leading zero (negative)", () => {
    for (const windowDays of ["", "0", "07", "10000", "1.5"]) {
      expect(
        refusal(
          BudgetForm.safeParse({ ...monthly, period: "rolling", windowDays }),
        ),
      ).toEqual({ field: "windowDays", message: "windowDaysInvalid" });
    }
  });
});

describe("budgetFieldErrors", () => {
  it("names the limit and the window by their path heads", () => {
    expect(
      budgetFieldErrors([
        { path: ["limit", "micros"] },
        { path: ["windowDays"] },
      ]),
    ).toEqual({ limit: "limitInvalid", windowDays: "windowDaysInvalid" });
  });

  it("names no field for a path it does not know or an empty path (negative)", () => {
    expect(budgetFieldErrors([{ path: ["scope"] }, { path: [] }])).toEqual({});
  });
});

describe("isStatementMonth", () => {
  it("accepts a four-digit year and a month from 01 to 12", () => {
    expect(isStatementMonth("2026-01")).toBe(true);
    expect(isStatementMonth("2026-12")).toBe(true);
  });

  it("refuses month 00, month 13, a day, and an unpadded month (negative)", () => {
    for (const value of ["2026-00", "2026-13", "2026-09-01", "2026-9"]) {
      expect(isStatementMonth(value)).toBe(false);
    }
  });
});

describe("isFindingId", () => {
  it("accepts a fnd_ id in lowercase base 36", () => {
    expect(isFindingId("fnd_01k5c1")).toBe(true);
  });

  it("refuses another prefix, uppercase, and a bare prefix (negative)", () => {
    for (const value of ["emd_01k5c1", "fnd_01K5C1", "fnd_", ""]) {
      expect(isFindingId(value)).toBe(false);
    }
  });
});

describe("PriceEntryForm", () => {
  const entry = {
    provider: " anthropic ",
    model: " claude-opus-5 ",
    modelAliases: "",
    effectiveFrom: "",
    tokenClass: "input_uncached",
    usdPerMillion: " 15 ",
  };

  it("reads a rate with no region, alias or date as the write-instant row", () => {
    expect(PriceEntryForm.parse(entry)).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      tokenClass: "input_uncached",
      region: null,
      usdPerMillion: 15,
    });
  });

  it("sends the aliases typed, split on commas and newlines, blanks dropped", () => {
    const parsed = PriceEntryForm.parse({
      ...entry,
      modelAliases: "opus-5, claude-opus-5-latest\n\n ,opus",
    });
    expect(parsed.modelAliases).toEqual([
      "opus-5",
      "claude-opus-5-latest",
      "opus",
    ]);
  });

  it("carries a region it was given, trimmed", () => {
    expect(PriceEntryForm.parse({ ...entry, region: " us-east-1 " })).toEqual(
      expect.objectContaining({ region: "us-east-1" }),
    );
  });

  it("widens a UTC day to its midnight and passes an instant through unchanged", () => {
    expect(
      PriceEntryForm.parse({ ...entry, effectiveFrom: "2026-10-01" })
        .effectiveFrom,
    ).toBe("2026-10-01T00:00:00.000Z");
    expect(
      PriceEntryForm.parse({
        ...entry,
        effectiveFrom: "2026-10-01T12:30:00.250Z",
      }).effectiveFrom,
    ).toBe("2026-10-01T12:30:00.250Z");
  });

  it("accepts six decimal places and the ceiling of one million", () => {
    expect(
      PriceEntryForm.parse({ ...entry, usdPerMillion: "0.000001" })
        .usdPerMillion,
    ).toBe(0.000001);
    expect(
      PriceEntryForm.parse({ ...entry, usdPerMillion: "1000000" })
        .usdPerMillion,
    ).toBe(1_000_000);
  });

  it.each([
    ["provider", { provider: "  " }, "providerInvalid"],
    ["provider", { provider: "p".repeat(129) }, "providerInvalid"],
    ["model", { model: "" }, "modelInvalid"],
    ["model", { model: "m".repeat(257) }, "modelInvalid"],
    ["region", { region: "r".repeat(65) }, "regionInvalid"],
    [
      "modelAliases",
      {
        modelAliases: Array.from(
          { length: 33 },
          (_, i) => `a${String(i)}`,
        ).join(","),
      },
      "aliasesInvalid",
    ],
    ["modelAliases", { modelAliases: "a".repeat(257) }, "aliasesInvalid"],
    ["effectiveFrom", { effectiveFrom: "1 October" }, "effectiveFromInvalid"],
    // The shape passes; the calendar does not: 30 February rolls into March.
    ["effectiveFrom", { effectiveFrom: "2026-02-30" }, "effectiveFromInvalid"],
    // The shape passes; hour 25 is no instant at all.
    [
      "effectiveFrom",
      { effectiveFrom: "2026-10-01T25:00:00Z" },
      "effectiveFromInvalid",
    ],
    ["tokenClass", { tokenClass: "tokens" }, "tokenClassInvalid"],
    ["usdPerMillion", { usdPerMillion: "1,000" }, "rateInvalid"],
    ["usdPerMillion", { usdPerMillion: "0.0000001" }, "rateInvalid"],
    ["usdPerMillion", { usdPerMillion: "1000001" }, "rateInvalid"],
  ])(
    "refuses a bad %s and names that field (negative)",
    (field, over, message) => {
      expect(refusal(PriceEntryForm.safeParse({ ...entry, ...over }))).toEqual({
        field,
        message,
      });
    },
  );
});

describe("RemovePriceEntryForm", () => {
  const row = {
    provider: " anthropic ",
    model: " claude-opus-5 ",
    region: "",
    tokenClass: "output",
  };

  it("reads the row's key with a blank region as the region-agnostic row", () => {
    expect(RemovePriceEntryForm.parse(row)).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      tokenClass: "output",
      region: null,
    });
  });

  it("carries the cancellation token, the region and a confirmed unpricing", () => {
    expect(
      RemovePriceEntryForm.parse({
        ...row,
        cancellationToken: "tok_1",
        region: " eu-west-1 ",
        confirmUnpriced: true,
      }),
    ).toEqual({
      cancellationToken: "tok_1",
      provider: "anthropic",
      model: "claude-opus-5",
      tokenClass: "output",
      region: "eu-west-1",
      confirmUnpriced: true,
    });
  });

  it("sends no confirmation unless it was given as true (negative)", () => {
    expect(
      RemovePriceEntryForm.parse({ ...row, confirmUnpriced: false }),
    ).not.toHaveProperty("confirmUnpriced");
  });

  it.each([
    ["provider", { provider: "" }, "providerInvalid"],
    ["provider", { provider: "p".repeat(129) }, "providerInvalid"],
    ["model", { model: " " }, "modelInvalid"],
    ["model", { model: "m".repeat(257) }, "modelInvalid"],
    ["region", { region: "r".repeat(65) }, "regionInvalid"],
    ["tokenClass", { tokenClass: "" }, "tokenClassInvalid"],
  ])(
    "refuses a bad %s and names that field (negative)",
    (field, over, message) => {
      expect(
        refusal(RemovePriceEntryForm.safeParse({ ...row, ...over })),
      ).toEqual({ field, message });
    },
  );
});

describe("priceFieldErrors", () => {
  it("names every field the form or the contract can refuse", () => {
    expect(
      priceFieldErrors(
        [
          "provider",
          "model",
          "region",
          "modelAliases",
          "effectiveFrom",
          "tokenClass",
          "usdPerMillion",
        ].map((head) => ({ path: [head, 0] })),
      ),
    ).toEqual({
      provider: "providerInvalid",
      model: "modelInvalid",
      region: "regionInvalid",
      modelAliases: "aliasesInvalid",
      effectiveFrom: "effectiveFromInvalid",
      tokenClass: "tokenClassInvalid",
      usdPerMillion: "rateInvalid",
    });
  });

  it("names no field for a path it does not know or an empty path (negative)", () => {
    expect(priceFieldErrors([{ path: ["unit"] }, { path: [] }])).toEqual({});
  });
});

describe("GatewayPolicyForm's permit-no-models control", () => {
  it("sends an empty allowlist, which permits nothing, and satisfies enforcement on its own", () => {
    expect(
      GatewayPolicyForm.parse({
        mode: "enforced",
        sessionLimit: "",
        // The typed list is overridden: the control is the whole decision.
        modelAllow: "claude-opus-5",
        permitNoModels: true,
        modelDeny: "",
      }),
    ).toEqual({
      mode: "enforced",
      sessionLimitUsd: null,
      modelAllow: [],
      modelDeny: [],
    });
  });
});
