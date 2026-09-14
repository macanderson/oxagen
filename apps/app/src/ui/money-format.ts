// Money formatting, the one place a `Money` becomes text (plan decision 8).
//
// `micros` is an integer count of micro-units of `currency`, carried as a
// decimal string because it is a bigint on the wire. It never passes through a
// float: the string is split into whole and fractional units with BigInt
// arithmetic and handed to Intl.NumberFormat as an exact decimal string (Intl
// formats string operands without converting them to a double), so
// "9007199254740993000000" still prints its last digit.
import type { Money } from "@/data/contracts/common";

export const MICROS_PER_UNIT = 1_000_000n;
const MICROS_PATTERN = /^-?\d+$/;

/** A money value whose `micros` is not an integer string, e.g. the mockup's "2,450.00". */
export class InvalidMoneyError extends Error {
  readonly code = "ui_invalid_money";

  constructor(readonly micros: string) {
    super(
      `money micros must be an integer string, got ${JSON.stringify(micros)}`,
    );
    this.name = "InvalidMoneyError";
  }
}

/** Parse a micros string into a bigint. Throws `InvalidMoneyError` on anything but an integer. */
export function parseMicros(micros: string): bigint {
  if (!MICROS_PATTERN.test(micros)) throw new InvalidMoneyError(micros);
  return BigInt(micros);
}

/** The exact amount in major units as a decimal string: "-1500000" → "-1.500000". */
export function microsToDecimal(micros: string): `${number}` {
  const value = parseMicros(micros);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / MICROS_PER_UNIT;
  const fraction = (magnitude % MICROS_PER_UNIT).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}` as `${number}`;
}

/** Order two micros strings exactly (for sorting): negative, zero or positive. */
export function compareMicros(a: string, b: string): number {
  const x = parseMicros(a);
  const y = parseMicros(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * - `standard`: the currency's own minor units ($2,450.00, ¥1,235), rounded half-even,
 *   the rounding spec §12.3 uses for statement lines.
 * - `exact`: every recorded micro-unit, trailing zeros trimmed to the minor units ($0.041265).
 * - `compact`: a large figure at a glance ($12.4K). Never for a figure a person reconciles.
 */
export type MoneyPrecision = "standard" | "exact" | "compact";

export type FormatMoneyOptions = {
  locale: string;
  precision?: MoneyPrecision;
  /** `exceptZero` prefixes a plus on gains, for deltas and variance. */
  signDisplay?: "auto" | "exceptZero" | "never";
};

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(
  locale: string,
  currency: string,
  precision: MoneyPrecision,
  signDisplay: NonNullable<FormatMoneyOptions["signDisplay"]>,
): Intl.NumberFormat {
  const key = `${locale}|${currency}|${precision}|${signDisplay}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const base: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
    signDisplay,
    roundingMode: "halfEven",
  };
  let options = base;
  if (precision === "exact") {
    const minor = new Intl.NumberFormat(locale, base).resolvedOptions()
      .minimumFractionDigits;
    options = {
      ...base,
      minimumFractionDigits: minor,
      maximumFractionDigits: 6,
    };
  } else if (precision === "compact") {
    options = {
      ...base,
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    };
  }
  const made = new Intl.NumberFormat(locale, options);
  formatterCache.set(key, made);
  return made;
}

/** Format a `Money` for display in `locale`. Throws `InvalidMoneyError` on a non-integer micros string. */
export function formatMoney(
  money: Pick<Money, "micros" | "currency">,
  { locale, precision = "standard", signDisplay = "auto" }: FormatMoneyOptions,
): string {
  const decimal = microsToDecimal(money.micros);
  return formatter(locale, money.currency, precision, signDisplay).format(
    decimal,
  );
}
