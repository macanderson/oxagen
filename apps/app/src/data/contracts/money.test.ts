// The micros seam: canonical micros strings and products at magnitudes a float
// cannot hold, with every non-integer input refused; a cost names its basis as
// a required key that may be null; a typed amount becomes micros by digit
// shifting.
import { describe, expect, it } from "vitest";
import {
  compareMicros,
  Cost,
  isCurrencyCode,
  Money,
  microsFromDecimal,
  sumExceeds,
  moneyFromMicros,
  mulMicros,
  ratioOfIntegers,
  ratioOfMicros,
  roundToCentsHalfEven,
  shareOfMicros,
  sumMoney,
} from "./money";

const usd = (micros: string) => ({ micros, currency: "USD" });

describe("moneyFromMicros", () => {
  it("keeps the recorded micros and currency", () => {
    expect(moneyFromMicros("4131265", "USD")).toEqual(usd("4131265"));
  });

  it("writes the canonical form: no leading zeros and no negative zero", () => {
    expect(moneyFromMicros("0004130000", "USD").micros).toBe("4130000");
    expect(moneyFromMicros("-0", "USD").micros).toBe("0");
  });

  it("keeps every digit past Number.MAX_SAFE_INTEGER", () => {
    expect(moneyFromMicros("9007199254740993000001", "USD").micros).toBe(
      "9007199254740993000001",
    );
  });

  it.each(["2,450.00", "2450.00", "", " 12", "1e6", "+5", "0x10"])(
    "refuses %j (negative)",
    (micros) => {
      expect(() => moneyFromMicros(micros, "USD")).toThrow(
        "micros must be an integer string",
      );
    },
  );
});

describe("ratioOfMicros", () => {
  it("divides one finding's saving by the listed total", () => {
    expect(ratioOfMicros(usd("98460000"), usd("196920000"))).toBe(0.5);
    expect(ratioOfMicros(usd("1"), usd("8"))).toBe(0.125);
  });

  it("divides at magnitudes a float would not hold exactly", () => {
    expect(
      ratioOfMicros(usd("9007199254740993"), usd("18014398509481986")),
    ).toBe(0.5);
  });

  it("answers a ratio above one where the part is larger, clamping nothing", () => {
    expect(ratioOfMicros(usd("3000000"), usd("2000000"))).toBe(1.5);
  });

  it("answers null for a zero total, so no share is printed (negative)", () => {
    expect(ratioOfMicros(usd("5000000"), usd("0"))).toBeNull();
  });

  it("answers null across two currencies (negative)", () => {
    expect(
      ratioOfMicros(usd("5000000"), { micros: "5000000", currency: "EUR" }),
    ).toBeNull();
  });

  it("refuses micros that are not an integer string (negative)", () => {
    expect(() => ratioOfMicros(usd("1.5"), usd("3000000"))).toThrow(
      "micros must be an integer string",
    );
  });
});

describe("mulMicros", () => {
  it("prices a block: 5,000 micros per GAU times 5,000 GAU is $25.00", () => {
    expect(mulMicros(usd("5000"), 5000)).toEqual(usd("25000000"));
  });

  it("keeps the currency and multiplies by zero to zero", () => {
    expect(mulMicros({ micros: "3210", currency: "EUR" }, 0)).toEqual({
      micros: "0",
      currency: "EUR",
    });
  });

  it("stays exact where a float product would round", () => {
    expect(mulMicros(usd("9007199254740993"), 1_000_000)).toEqual(
      usd("9007199254740993000000"),
    );
    expect(mulMicros(usd("-3210"), Number.MAX_SAFE_INTEGER)).toEqual(
      usd("-28913109607718581110"),
    );
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses the quantity %s (negative)",
    (quantity) => {
      expect(() => mulMicros(usd("5000"), quantity)).toThrow(
        "quantity must be a safe integer",
      );
    },
  );

  it("refuses a micros value that is not an integer string (negative)", () => {
    expect(() => mulMicros(usd("0.005"), 2)).toThrow(
      "micros must be an integer string",
    );
  });
});

describe("shareOfMicros", () => {
  it("takes the named share of the micros, exact past a float", () => {
    expect(shareOfMicros(usd("4200000"), 0.25)).toEqual(usd("1050000"));
    expect(shareOfMicros(usd("90071992547409930"), 0.5)).toEqual(
      usd("45035996273704965"),
    );
  });

  it("truncates toward zero at the millionth", () => {
    expect(shareOfMicros(usd("3"), 1 / 3)).toEqual(usd("0"));
  });

  it("answers null for a share outside 0 to 1", () => {
    expect(shareOfMicros(usd("100"), -0.1)).toBeNull();
    expect(shareOfMicros(usd("100"), 1.2)).toBeNull();
    expect(shareOfMicros(usd("100"), Number.NaN)).toBeNull();
  });
});

describe("sumMoney", () => {
  it("adds micros exactly past what a float holds", () => {
    expect(sumMoney([usd("9007199254740993"), usd("1")])).toEqual(
      usd("9007199254740994"),
    );
  });

  it("answers null for nothing to sum (negative)", () => {
    expect(sumMoney([])).toBeNull();
  });

  it("answers null across currencies rather than a meaningless total (negative)", () => {
    expect(
      sumMoney([usd("1000000"), { micros: "1000000", currency: "EUR" }]),
    ).toBeNull();
  });

  it("refuses a micros string that is not an integer", () => {
    expect(() => sumMoney([usd("1.5")])).toThrow(/micros must be an integer/);
  });
});

describe("Money and Cost", () => {
  it("accept integer micros, a three-letter currency and a nullable basis", () => {
    expect(Money.safeParse(usd("-12")).success).toBe(true);
    expect(Cost.safeParse({ ...usd("12"), basis: null }).success).toBe(true);
    expect(
      Cost.safeParse({ ...usd("12"), basis: "gateway_observed" }).success,
    ).toBe(true);
  });

  it("refuse a display string, a currency name and a missing basis key (negative)", () => {
    expect(Money.safeParse(usd("2,450.00")).success).toBe(false);
    expect(Money.safeParse({ micros: "1", currency: "dollars" }).success).toBe(
      false,
    );
    expect(Cost.safeParse(usd("1")).success).toBe(false);
  });
});

describe("Cost", () => {
  it("carries the basis the rollup recorded, or null", () => {
    expect(
      Cost.parse({ micros: "1", currency: "USD", basis: "estimated" }).basis,
    ).toBe("estimated");
    expect(
      Cost.parse({ micros: "1", currency: "USD", basis: null }).basis,
    ).toBe(null);
  });

  it("refuses a cost with no basis key and a basis no store records (negative)", () => {
    expect(Cost.safeParse({ micros: "1", currency: "USD" }).success).toBe(
      false,
    );
    expect(
      Cost.safeParse({ micros: "1", currency: "USD", basis: "measured" })
        .success,
    ).toBe(false);
  });
});

describe("microsFromDecimal", () => {
  it.each([
    ["500", "500000000"],
    ["0.25", "250000"],
    [" 12.000001 ", "12000001"],
    ["0", "0"],
    ["007.5", "7500000"],
  ])("reads %j as %s micros", (text, micros) => {
    expect(microsFromDecimal(text)).toBe(micros);
  });

  it.each(["", "-5", "1,250", "1.0000001", "1e3", ".5", "5.", "1234567890123"])(
    "refuses %j (negative)",
    (text) => {
      expect(microsFromDecimal(text)).toBeNull();
    },
  );
});

describe("isCurrencyCode", () => {
  it("knows the ISO 4217 codes a limit may name", () => {
    for (const code of ["USD", "EUR", "JPY"])
      expect(isCurrencyCode(code)).toBe(true);
  });

  it("refuses a well-formed three-letter unit that is not one (negative)", () => {
    for (const unit of ["GAU", "RPM", "calls", "usd", ""])
      expect(isCurrencyCode(unit)).toBe(false);
  });
});

describe("ratioOfIntegers", () => {
  it.each([
    ["1204180000", "2000000000", 0.60209],
    ["11", "50", 0.22],
    ["0", "50", 0],
  ])("reads %s of %s as a fraction", (part, whole, ratio) => {
    expect(ratioOfIntegers(part, whole)).toBe(ratio);
  });

  it("holds the fraction at magnitudes a double cannot carry", () => {
    expect(
      ratioOfIntegers("500000000000000000000", "1000000000000000000000"),
    ).toBe(0.5);
  });

  it("clamps a draw at or past the limit to the whole (negative)", () => {
    expect(ratioOfIntegers("60", "50")).toBe(1);
    expect(ratioOfIntegers("50", "50")).toBe(1);
  });

  it.each([
    ["5", "0"],
    ["-5", "50"],
  ])("answers 0 for %s of %s (negative)", (part, whole) => {
    expect(ratioOfIntegers(part, whole)).toBe(0);
  });

  it("refuses a figure that is not an integer string (negative)", () => {
    expect(() => ratioOfIntegers("1.5", "50")).toThrow(/integer string/);
  });
});

describe("sumExceeds", () => {
  // The question `ratioOfIntegers` destroys: it clamps to 1, so an excess
  // carried by one component alone is indistinguishable from exactly full.
  it.each([
    ["600", "0", "500", true],
    ["0", "600", "500", true],
    ["500", "500", "500", true],
    ["500", "0", "500", false],
    ["250", "250", "500", false],
    ["1", "0", "0", true],
    ["0", "0", "0", false],
  ])("%s + %s against %s is %s", (a, b, whole, expected) => {
    expect(sumExceeds(a, b, whole)).toBe(expected);
  });

  it("is exact past what a double holds", () => {
    expect(sumExceeds("9007199254740993", "0", "9007199254740992")).toBe(true);
    expect(sumExceeds("9007199254740992", "0", "9007199254740993")).toBe(false);
  });

  it("refuses a figure that is not an integer string (negative)", () => {
    expect(() => sumExceeds("1.5", "0", "5")).toThrow();
  });
});

describe("roundToCentsHalfEven", () => {
  it("rounds a half cent to the even cent, up and down", () => {
    expect(roundToCentsHalfEven(usd("1005000"))).toEqual(usd("1000000"));
    expect(roundToCentsHalfEven(usd("1015000"))).toEqual(usd("1020000"));
  });

  it("rounds past the half up and short of it down", () => {
    expect(roundToCentsHalfEven(usd("1005001"))).toEqual(usd("1010000"));
    expect(roundToCentsHalfEven(usd("1004999"))).toEqual(usd("1000000"));
  });

  it("rounds a negative amount by its magnitude and never prints -0", () => {
    expect(roundToCentsHalfEven(usd("-1015000"))).toEqual(usd("-1020000"));
    expect(roundToCentsHalfEven(usd("-4000"))).toEqual(usd("0"));
  });

  it("stays exact past what a float holds", () => {
    expect(roundToCentsHalfEven(usd("90071992547409915000"))).toEqual(
      usd("90071992547409920000"),
    );
  });

  it("refuses micros that are not an integer string (negative)", () => {
    expect(() => roundToCentsHalfEven(usd("1.5"))).toThrow(/micros/);
  });
});

describe("compareMicros", () => {
  it.each([
    ["1", "2", -1],
    ["2", "1", 1],
    ["7", "7", 0],
    ["0", "0", 0],
  ])("orders %s against %s as %i", (a, b, expected) => {
    expect(Math.sign(compareMicros(a, b))).toBe(expected);
  });

  it("orders figures past what a double holds exactly", () => {
    expect(compareMicros("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareMicros("9007199254740992", "9007199254740993")).toBe(-1);
  });

  it("refuses micros that are not an integer string (negative)", () => {
    expect(() => compareMicros("1.5", "2")).toThrow(/micros/);
  });
});
