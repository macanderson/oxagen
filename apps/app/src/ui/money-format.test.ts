import { describe, expect, it } from "vitest";
import {
  InvalidMoneyError,
  compareMicros,
  formatMoney,
  microsToDecimal,
  parseMicros,
} from "./money-format";

const usd = (micros: string) => ({ micros, currency: "USD" });

describe("microsToDecimal", () => {
  it.each([
    ["0", "0.000000"],
    ["1", "0.000001"],
    ["41265", "0.041265"],
    ["2450000000", "2450.000000"],
    ["-1500000", "-1.500000"],
    ["-0", "0.000000"],
    ["9007199254740993000001", "9007199254740993.000001"],
  ])("%s micros → %s", (micros, decimal) => {
    expect(microsToDecimal(micros)).toBe(decimal);
  });
});

describe("parseMicros", () => {
  it("returns a bigint beyond the float range without losing a digit", () => {
    expect(parseMicros("9007199254740993000001")).toBe(9007199254740993000001n);
  });

  it.each(["2,450.00", "2450.00", "", " 12", "1e6", "+5", "0x10", "NaN"])(
    "refuses %j",
    (micros) => {
      expect(() => parseMicros(micros)).toThrow(InvalidMoneyError);
    },
  );

  it("names the offending value and a stable code", () => {
    const error = (() => {
      try {
        parseMicros("2,450.00");
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(InvalidMoneyError);
    expect(error).toMatchObject({
      code: "ui_invalid_money",
      micros: "2,450.00",
    });
  });
});

describe("formatMoney", () => {
  const en = { locale: "en-US" };

  it("formats bigint micros in the currency's minor units", () => {
    expect(formatMoney(usd("2450000000"), en)).toBe("$2,450.00");
    expect(formatMoney(usd("4130000"), en)).toBe("$4.13");
    expect(formatMoney(usd("0"), en)).toBe("$0.00");
  });

  it("prints a value past Number.MAX_SAFE_INTEGER exactly, which a float cannot", () => {
    // 9,007,199,254,740,993 is 2^53 + 1: as a double it becomes …992.
    expect(formatMoney(usd("9007199254740993000000"), en)).toBe(
      "$9,007,199,254,740,993.00",
    );
  });

  it("formats negative amounts", () => {
    expect(formatMoney(usd("-1500000"), en)).toBe("-$1.50");
    expect(formatMoney(usd("-41265"), { ...en, precision: "exact" })).toBe(
      "-$0.041265",
    );
  });

  it("signs a delta when asked", () => {
    expect(
      formatMoney(usd("1500000"), { ...en, signDisplay: "exceptZero" }),
    ).toBe("+$1.50");
    expect(formatMoney(usd("0"), { ...en, signDisplay: "exceptZero" })).toBe(
      "$0.00",
    );
  });

  it("rounds half to even, as statement lines do", () => {
    expect(formatMoney(usd("5000"), en)).toBe("$0.00"); // 0.005 → 0.00
    expect(formatMoney(usd("15000"), en)).toBe("$0.02"); // 0.015 → 0.02
    expect(formatMoney(usd("25000"), en)).toBe("$0.02"); // 0.025 → 0.02
    expect(formatMoney(usd("25001"), en)).toBe("$0.03");
  });

  it("follows the currency's own minor units and the locale's separators", () => {
    expect(formatMoney({ micros: "1234560000", currency: "JPY" }, en)).toBe(
      "¥1,235",
    );
    expect(
      formatMoney(
        { micros: "2450000000", currency: "EUR" },
        { locale: "de-DE" },
      ),
    ).toBe("2.450,00 €");
    expect(formatMoney({ micros: "2450000000", currency: "GBP" }, en)).toBe(
      "£2,450.00",
    );
  });

  it("shows every recorded micro-unit at exact precision", () => {
    expect(formatMoney(usd("41265"), { ...en, precision: "exact" })).toBe(
      "$0.041265",
    );
    expect(formatMoney(usd("4130000"), { ...en, precision: "exact" })).toBe(
      "$4.13",
    );
  });

  it("abbreviates a large figure at compact precision", () => {
    expect(
      formatMoney(usd("12450000000"), { ...en, precision: "compact" }),
    ).toBe("$12.4K");
    expect(
      formatMoney(usd("3200000000000"), { ...en, precision: "compact" }),
    ).toBe("$3.2M");
  });

  it("refuses a display string instead of silently formatting it as zero", () => {
    expect(() => formatMoney(usd("2,450.00"), en)).toThrow(InvalidMoneyError);
  });
});

describe("compareMicros", () => {
  it("orders exactly, including beyond the float range", () => {
    expect(compareMicros("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareMicros("-5", "3")).toBe(-1);
    expect(compareMicros("100", "100")).toBe(0);
  });
});
