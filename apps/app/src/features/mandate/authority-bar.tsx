// The remaining-authority bar at the head of the ledger (the design's
// `mandateBar`): what this period has settled, what calls in flight have
// reserved, and what is left of the per-period limit, each with its share.
//
// The figures and the two ratios are the ledger's own (INV-10), carried on the
// mandate's authority, so the bar, the tiles above it and the table beneath it
// read one record and nothing here sums anything.
//
// A reservation is drawn only while one is held. The design labels it
// "reserved by this call". That is true when exactly one call holds a
// reservation, so the legend says it then, names the count when several do,
// and says "reserved by calls in flight" when the read filled its bound and an
// older open reservation may be missing from it (`openCalls`).
//
// A limit lowered under authority already drawn leaves the drawn figures above
// the limit. The settled segment takes what it measures and the reservation
// takes only the room left, so neither shrinks to fit, and `overLimit` (taken
// on the recorded integers, never on the clamped ratios) adds a sentence.
import { useLocale, useTranslations } from "next-intl";
import type { MandateAuthority } from "@/data/contracts/mandates";
import { eyebrow } from "@/ui/control-styles";
import { useMeasureText } from "@/ui/measure";
import { formatRatio, ratioWidth } from "@/ui/money-format";
import { isDrawn, unitOf } from "./view";

export function AuthorityBar({
  authority,
  named,
  openCalls,
}: {
  authority: MandateAuthority;
  /** How many calls hold a reservation on this measure; null when the read cannot say. */
  openCalls: number | null;
  /** Whether to name the measure beside the heading: true when the page draws more than one bar. */
  named: boolean;
}) {
  const t = useTranslations("mandate.bar");
  const text = useMeasureText();
  const locale = useLocale();
  const { perPeriod, settledRatio, reservedRatio, remaining } = authority;
  if (perPeriod === null || settledRatio === null || reservedRatio === null)
    return null;
  const showReserved = isDrawn(authority.reserved);
  const settledWidth = Math.min(1, Math.max(0, settledRatio));
  const reservedWidth = showReserved
    ? Math.min(Math.max(0, reservedRatio), 1 - settledWidth)
    : 0;
  const left = remaining === null ? text(perPeriod) : text(remaining);
  const by =
    openCalls === 1
      ? t("by.one")
      : openCalls === null || openCalls === 0
        ? t("by.unknown")
        : t("by.many", { count: String(openCalls) });
  const label = showReserved
    ? t("labelReserved", {
        settled: text(authority.settled),
        reserved: text(authority.reserved),
        by,
        remaining: left,
        limit: text(perPeriod),
      })
    : t("label", {
        settled: text(authority.settled),
        remaining: left,
        limit: text(perPeriod),
      });
  return (
    <div data-testid="authority-bar" data-measure={authority.measure}>
      <div className="mb-[7px] flex flex-wrap items-baseline justify-between gap-2">
        <span className={eyebrow}>
          {t("title")}
          {named ? (
            <span className="ms-2 font-mono normal-case tracking-normal text-muted-foreground">
              {authority.measure}
            </span>
          ) : null}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {perPeriod.kind === "money"
            ? t("ofMoney", {
                limit: text(perPeriod),
                currency: unitOf(authority),
              })
            : t("of", { limit: text(perPeriod) })}
        </span>
      </div>
      <div
        role="img"
        aria-label={authority.overLimit ? `${label} ${t("overLimit")}` : label}
        className="flex h-3 w-full overflow-hidden rounded-full border border-border bg-hl"
      >
        <i
          data-part="settled"
          style={{ width: ratioWidth(settledWidth) }}
          className="block h-full shrink-0 bg-success/60"
        />
        {showReserved ? (
          <i
            data-part="reserved"
            style={{ width: ratioWidth(reservedWidth) }}
            className="block h-full shrink-0 bg-[repeating-linear-gradient(45deg,var(--st-approval)_0_4px,color-mix(in_srgb,var(--st-approval)_45%,transparent)_4px_8px)]"
          />
        ) : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <i
            aria-hidden="true"
            className="block size-[9px] rounded-[3px] bg-success/60"
          />
          {t("settled", { value: text(authority.settled) })}
          <span className="text-dim">
            {t("share", { share: formatRatio(settledRatio, locale) })}
          </span>
        </li>
        {showReserved ? (
          <li className="inline-flex items-center gap-1.5">
            <i
              aria-hidden="true"
              className="block size-[9px] rounded-[3px] bg-info"
            />
            {t("reserved", { by, value: text(authority.reserved) })}
            <span className="text-dim">
              {t("share", { share: formatRatio(reservedRatio, locale) })}
            </span>
          </li>
        ) : null}
        <li className="inline-flex items-center gap-1.5">
          <i
            aria-hidden="true"
            className="block size-[9px] rounded-[3px] border border-border bg-hl"
          />
          {t("remaining", { value: left })}
        </li>
      </ul>
      {authority.overLimit ? (
        <p data-state="over-limit" className="mt-1 text-xs text-foreground">
          {t("overLimit")}
        </p>
      ) : null}
    </div>
  );
}
