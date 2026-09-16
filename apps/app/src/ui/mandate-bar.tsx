// The mandate bar (#2957; mockup `mandateBar`): remaining authority for one
// measure of one mandate — what this period has settled, what calls in flight
// have reserved, and what is left of the per-period limit. The figures and
// the two ratios come from the ledger through the view model (INV-10), so the
// bar draws what is recorded and computes nothing.
//
// A reservation is drawn only while one is held, which is what the ledger says
// when `reserved` is above zero; a measure with no per-period limit has no
// denominator and so no bar.
import { useTranslations } from "next-intl";
import type { MandateAuthority } from "@/data/contracts/mandates";
import { eyebrow } from "./control-styles";
import { Measure, useMeasureText } from "./measure";
import { ratioWidth } from "./money-format";

function isDrawn(value: MandateAuthority["reserved"]): boolean {
  return value.kind === "money" ? value.money.micros !== "0" : value.count > 0;
}

export function MandateBar({ authority }: { authority: MandateAuthority }) {
  const t = useTranslations("ui.mandateBar");
  const text = useMeasureText();
  const { perPeriod, settledRatio, reservedRatio, remaining } = authority;
  if (perPeriod === null || settledRatio === null || reservedRatio === null) {
    return null;
  }
  const showReserved = isDrawn(authority.reserved);
  const label = t(showReserved ? "labelReserved" : "label", {
    settled: text(authority.settled),
    reserved: text(authority.reserved),
    remaining: remaining === null ? text(perPeriod) : text(remaining),
    limit: text(perPeriod),
  });
  return (
    <div data-testid="mandate-bar" data-measure={authority.measure}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={eyebrow}>
          {t("title", {
            period: t(`period.${authority.period}`),
            periodKey: authority.periodKey,
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t.rich("of", { limit: () => <Measure value={perPeriod} /> })}
        </span>
      </div>
      <div
        role="img"
        aria-label={label}
        className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <i
          data-part="settled"
          style={{ width: ratioWidth(settledRatio) }}
          className="block h-full bg-foreground"
        />
        {showReserved ? (
          <i
            data-part="reserved"
            style={{ width: ratioWidth(reservedRatio) }}
            className="block h-full bg-foreground/40"
          />
        ) : null}
      </div>
      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{t("settled")}</dt>
          <dd>
            <Measure value={authority.settled} />
          </dd>
        </div>
        {showReserved ? (
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("reserved")}</dt>
            <dd>
              <Measure value={authority.reserved} />
            </dd>
          </div>
        ) : null}
        {remaining === null ? null : (
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("remaining")}</dt>
            <dd>
              <Measure value={remaining} />
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
