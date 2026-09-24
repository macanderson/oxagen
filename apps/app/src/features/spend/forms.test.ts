// The price-book forms and the field maps every Spend dialog shares: each
// refusal names the one field it is about, a region left blank reads as no
// region, and the second submit that accepts an unpriced class carries its
// confirmation and nothing else.
import { describe, expect, it } from "vitest";
import {
  budgetFieldErrors,
  PriceEntryForm,
  priceFieldErrors,
  RemovePriceEntryForm,
} from "./forms";

const ENTRY = {
  provider: "anthropic",
  model: "claude-opus-5",
  region: "",
  modelAliases: "",
  effectiveFrom: "",
  tokenClass: "output",
  usdPerMillion: "15",
};

const REMOVAL = {
  provider: "anthropic",
  model: "claude-opus-5",
  region: "",
  tokenClass: "output",
};

/** The field and catalog key the form's first refusal names. */
function refusal(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  const [issue] = result.error?.issues ?? [];
  return issue === undefined
    ? null
    : { field: issue.path.map(String).join("."), code: issue.message };
}

describe("PriceEntryForm", () => {
  it("refuses a region longer than a region name can be", () => {
    expect(
      refusal(PriceEntryForm.safeParse({ ...ENTRY, region: "r".repeat(65) })),
    ).toEqual({ field: "region", code: "regionInvalid" });
  });

  it("keeps a named region and reads a blank one as none", () => {
    const named = PriceEntryForm.safeParse({ ...ENTRY, region: " eu-west-1 " });
    expect(named.success && named.data.region).toBe("eu-west-1");
    const blank = PriceEntryForm.safeParse(ENTRY);
    expect(blank.success && blank.data.region).toBeNull();
  });
});

describe("RemovePriceEntryForm", () => {
  it.each([
    ["provider", { provider: " " }, "providerInvalid"],
    ["provider", { provider: "p".repeat(129) }, "providerInvalid"],
    ["model", { model: "" }, "modelInvalid"],
    ["model", { model: "m".repeat(257) }, "modelInvalid"],
    ["region", { region: "r".repeat(65) }, "regionInvalid"],
    ["tokenClass", { tokenClass: "tokens" }, "tokenClassInvalid"],
  ] as const)(
    "refuses a bad %s, naming it (negative)",
    (field, change, code) => {
      expect(
        refusal(RemovePriceEntryForm.safeParse({ ...REMOVAL, ...change })),
      ).toEqual({ field, code });
    },
  );

  it("reads the row's key, with its region, token and the confirmation only when given", () => {
    const first = RemovePriceEntryForm.safeParse({
      ...REMOVAL,
      region: " us-east-1 ",
    });
    expect(first.success && first.data).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      tokenClass: "output",
      region: "us-east-1",
    });
    const confirmed = RemovePriceEntryForm.safeParse({
      ...REMOVAL,
      cancellationToken: "tok_1",
      confirmUnpriced: true,
    });
    expect(confirmed.success && confirmed.data).toEqual({
      cancellationToken: "tok_1",
      provider: "anthropic",
      model: "claude-opus-5",
      tokenClass: "output",
      region: null,
      confirmUnpriced: true,
    });
    const declined = RemovePriceEntryForm.safeParse({
      ...REMOVAL,
      confirmUnpriced: false,
    });
    expect(declined.success && declined.data).not.toHaveProperty(
      "confirmUnpriced",
    );
  });
});

describe("priceFieldErrors", () => {
  it("maps every field a refusal can name to its message, and ignores any other path", () => {
    expect(
      priceFieldErrors([
        { path: ["provider"] },
        { path: ["model"] },
        { path: ["region"] },
        { path: ["modelAliases", 0] },
        { path: ["effectiveFrom"] },
        { path: ["tokenClass"] },
        { path: ["usdPerMillion"] },
        { path: ["somethingElse"] },
        { path: [] },
      ]),
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
});

describe("budgetFieldErrors", () => {
  it("names no field for a refusal with no path (negative)", () => {
    expect(budgetFieldErrors([{ path: [] }])).toEqual({});
  });
});
