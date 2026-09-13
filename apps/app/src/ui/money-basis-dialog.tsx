"use client";

// The basis dialog behind a large money figure (feedback 5): what the basis of
// this figure is, what each basis means, and the exact recorded amount.
import { CostBasis } from "@/data/contracts/common";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { cx } from "./cx";
import { DialogPanel, DialogRoot, DialogTrigger } from "./dialog-shell";

export type MoneyBasisDialogProps = {
  basis: CostBasis | null;
  /** The figure as displayed, for the trigger's accessible name. */
  amount: string;
  /** Every recorded micro-unit, formatted. */
  exact: string;
  currency: string;
};

export function MoneyBasisDialog({
  basis,
  amount,
  exact,
  currency,
}: MoneyBasisDialogProps) {
  const t = useTranslations("ui");
  const key = basis ?? "unknown";
  return (
    <DialogRoot>
      <DialogTrigger
        aria-label={t("money.openBasis", { amount })}
        className={cx(
          "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          basis === null && "border-dashed",
        )}
      >
        {t(`basis.${key}.label`)}
        <Info aria-hidden focusable={false} className="size-3" />
      </DialogTrigger>
      <DialogPanel
        title={t("money.dialogTitle")}
        description={t("money.dialogDescription")}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("money.exactLabel")}</dt>
          <dd className="font-mono tabular-nums">
            {t("money.exactValue", { amount: exact, currency })}
          </dd>
        </dl>
        <ul className="flex flex-col gap-2">
          {CostBasis.options.map((option) => {
            const isCurrent = option === basis;
            return (
              <li
                key={option}
                data-current={isCurrent || undefined}
                className={cx(
                  "rounded-md border p-3 text-sm",
                  isCurrent ? "border-foreground/40 bg-muted" : "border-border",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">
                    {t(`basis.${option}.label`)}
                  </span>
                  {isCurrent ? (
                    <span className="ml-auto text-xs font-medium">
                      {t("money.currentBasis")}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {t(`basis.${option}.description`)}
                </p>
              </li>
            );
          })}
          {basis === null ? (
            <li
              data-current
              className="rounded-md border border-dashed border-foreground/40 bg-muted p-3 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">
                  {t("basis.unknown.label")}
                </span>
                <span className="ml-auto text-xs font-medium">
                  {t("money.currentBasis")}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">
                {t("basis.unknown.description")}
              </p>
            </li>
          ) : null}
        </ul>
      </DialogPanel>
    </DialogRoot>
  );
}
