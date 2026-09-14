// <Money>: the only component that turns a `Money` into text. Every figure
// shows its basis (spec §14 interaction rules): inline as a quiet mono label,
// and on the large figure (feedback 5: a run's cost, big, beside its name) as a
// button that opens the basis dialog.
import { useLocale, useTranslations } from "next-intl";
import type { Money as MoneyValue } from "@/data/contracts/common";
import { cx } from "./cx";
import { MoneyBasisDialog } from "./money-basis-dialog";
import {
  type FormatMoneyOptions,
  type MoneyPrecision,
  formatMoney,
} from "./money-format";

export type MoneyProps = {
  value: MoneyValue;
  /** `large` is the headline figure with the basis dialog; `inline` sits in a row or a sentence. */
  variant?: "inline" | "large";
  precision?: MoneyPrecision;
  signDisplay?: FormatMoneyOptions["signDisplay"];
  /** Hide the basis only where a column header or a caption already states it once for every figure. */
  showBasis?: boolean;
  className?: string;
};

export function Money({
  value,
  variant = "inline",
  precision = "standard",
  signDisplay = "auto",
  showBasis = true,
  className,
}: MoneyProps) {
  const locale = useLocale();
  const t = useTranslations("ui.basis");
  const text = formatMoney(value, { locale, precision, signDisplay });
  const basis = value.basis ?? "unknown";

  if (variant === "large") {
    const exact = formatMoney(value, {
      locale,
      precision: "exact",
      signDisplay,
    });
    return (
      <span
        className={cx("inline-flex flex-wrap items-center gap-2", className)}
        data-testid="money"
        data-basis={basis}
      >
        <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {text}
        </span>
        {showBasis ? (
          <MoneyBasisDialog
            basis={value.basis ?? null}
            amount={text}
            exact={exact}
            currency={value.currency}
          />
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={cx("inline-flex items-baseline gap-1.5", className)}
      data-testid="money"
      data-basis={basis}
    >
      <span className="tabular-nums">{text}</span>
      {showBasis ? (
        <span
          className="font-mono text-[10.5px] text-muted-foreground"
          title={t(`${basis}.description`)}
        >
          {t(`${basis}.label`)}
        </span>
      ) : null}
    </span>
  );
}
