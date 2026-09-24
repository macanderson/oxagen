// The mandate bar (#2957; mockup `mandateBar`): remaining authority for one
// measure of one mandate — what this period has settled, what calls in flight
// have reserved, and what is left of the per-period limit. The figures and
// the two ratios come from the ledger through the view model (INV-10), so the
// bar draws what is recorded and computes nothing.
//
// A reservation is drawn only while one is held, which is what the ledger says
// when `reserved` is above zero; a measure with no per-period limit has no
// denominator and so no bar.
//
// `update_mandate_limits` may lower a limit under authority already drawn, so
// the drawn figures can exceed the limit they are drawn against. Two separate
// things go wrong there and each needs its own answer.
//
// Drawing: clamping each segment on its own and letting flex resolve the
// overflow rescales both — 500 settled and 500 reserved against a limit
// lowered to 500 draws an even split, reading as a bar half used. So the
// reservation takes the room settlement leaves and neither segment shrinks.
//
// Saying: the message names the excess and not where it sits. `overLimit` is
// the sum against the limit, so it is true when settlement alone carries the
// excess, when an open reservation alone does, and when the two together do —
// and this surface teaches elsewhere that settled means completed effects and
// reserved means calls still in flight. Calling a reservation-only excess
// "fully settled" would tell the accountable reader an effect had happened
// that has not. The bar and the figures beneath it already show the split, so
// the sentence states the fact and points at them.
//
// The fact of the excess is not recoverable from the ratios, because
// `ratioOfIntegers` clamps each to 1 — 600 settled against a limit of 500
// arrives as 1, and 1 + 0 is not greater than 1, so a sum of ratios would miss
// a single-component excess entirely and quantization could round a small
// combined one away. The view model carries `overLimit`, taken on the recorded
// integers before any of that.
import { useTranslations } from "next-intl";
import type { MandateAuthority } from "@/data/contracts/mandates";
import { eyebrow } from "./control-styles";
import { Measure, useMeasureText } from "./measure";
import { ratioWidth } from "./money-format";

/** Whether the ledger holds anything under this figure; both forms are integer strings. */
function isDrawn(value: MandateAuthority["reserved"]): boolean {
  const digits = value.kind === "money" ? value.money.micros : value.count;
  return /[1-9]/.test(digits);
}

/**
 * Whether this measure has what a bar needs: a per-period limit for its
 * denominator and the two ratios drawn against it. Exported because a caller
 * deciding what else to render has to ask the same question the component
 * answers — the approval card partitions a mandate's measures by it — and
 * two predicates that must agree are one that will eventually not.
 */
export function drawsBar(authority: MandateAuthority): boolean {
  return (
    authority.perPeriod !== null &&
    authority.settledRatio !== null &&
    authority.reservedRatio !== null
  );
}

export function MandateBar({ authority }: { authority: MandateAuthority }) {
  const t = useTranslations("ui.mandateBar");
  const text = useMeasureText();
  const { perPeriod, settledRatio, reservedRatio, remaining } = authority;
  if (!drawsBar(authority) || perPeriod === null) return null;
  // `drawsBar` has established both, and narrowing needs them named.
  if (settledRatio === null || reservedRatio === null) return null;
  const showReserved = isDrawn(authority.reserved);
  // The settled segment takes what it measures; the reservation takes what is
  // left of the track, so the two never total more than the limit they draw.
  const settledWidth = Math.min(1, Math.max(0, settledRatio));
  const reservedWidth = Math.min(Math.max(0, reservedRatio), 1 - settledWidth);
  /** Answered from the ledger's integers (`sumExceeds`), never from the clamped ratios. */
  const over = authority.overLimit;
  // The measure names itself in the heading and in the accessible name, not
  // only in a data attribute: an approval card draws one bar per measure, and
  // two per-period measures in one currency are otherwise indistinguishable
  // both on screen and to a screen reader. The component takes the authority,
  // so the name is always to hand and no caller can decline to pass it.
  const label = t(showReserved ? "labelReserved" : "label", {
    measure: authority.measure,
    settled: text(authority.settled),
    reserved: text(authority.reserved),
    remaining: remaining === null ? text(perPeriod) : text(remaining),
    limit: text(perPeriod),
  });
  return (
    <div
      data-testid="mandate-bar"
      data-measure={authority.measure}
      data-over={over ? "true" : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={eyebrow}>
          {t("title", {
            measure: authority.measure,
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
        aria-label={over ? `${label} ${t("overLimit")}` : label}
        className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <i
          data-part="settled"
          style={{ width: ratioWidth(settledWidth) }}
          className="block h-full shrink-0 bg-foreground"
        />
        {showReserved ? (
          <i
            data-part="reserved"
            style={{ width: ratioWidth(reservedWidth) }}
            className="block h-full shrink-0 bg-foreground/40"
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
      {over ? (
        <p data-state="over-limit" className="mt-1 text-xs text-foreground">
          {t("overLimit")}
        </p>
      ) : null}
    </div>
  );
}
