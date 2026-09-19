// <Money>: the only component that turns a `Money` into text (INV-09). The
// basis of a metered figure is the caller's to print, beside it.
import { useLocale } from "next-intl";
import type { Money as MoneyValue } from "@/data/contracts/money";
import { formatMoney, type MoneyPrecision } from "./money-format";

export function Money({
  value,
  precision = "cents",
}: {
  value: MoneyValue;
  precision?: MoneyPrecision;
}) {
  const locale = useLocale();
  return (
    // The kit gives numbers in tables to Monaspace Neon, whose figures are
    // one width and whose texture healing keeps a column of them even.
    <span data-testid="money" className="font-mono tabular-nums">
      {formatMoney(value, { locale, precision })}
    </span>
  );
}
