// The micros seam: canonical micros strings and products at magnitudes a float
// cannot hold, with every non-integer input refused; a cost names its basis as
// a required key that may be null; a typed amount becomes micros by digit
// shifting.
import { describe, expect, it } from "vitest";
import {
  Cost,
  Money,
  microsFromDecimal,
  moneyFromMicros,
  mulMicros,
  ratioOfMicros,
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

describe("Money", () => {
  it("accepts integer micros and a three-letter currency", () => {
    expect(Money.safeParse(usd("-12")).success).toBe(true);
  });

  it("refuses a display string and a currency name (negative)", () => {
    expect(Money.safeParse(usd("2,450.00")).success).toBe(false);
    expect(Money.safeParse({ micros: "1", currency: "dollars" }).success).toBe(
      false,
    );
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
