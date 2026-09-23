// The Ledger panel, left of the grant (the design's `pMandate`): the
// remaining-authority bar for each measure with a period limit, the sentence on
// why two calls cannot both fit under one remaining limit, then the table of
// every draw.
//
// A mandate that has never been drawn on shows the design's empty state in
// place of the bar and the table, and says remaining authority equals the full
// period limit only when that is true: enforcement honours only an active
// mandate inside its half-open window (`isEffective`), so a draft, revoked,
// expired or not-yet-started mandate has no remaining authority however much of
// its limit is undrawn.
import { useTranslations } from "next-intl";
import { isEffective, type MandateDetail } from "@/data/contracts/mandates";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { AuthorityBar } from "./authority-bar";
import { LedgerTable } from "./ledger-table";
import { NotBacked, StateWrap } from "./state";

export function MandateLedger({ detail }: { detail: MandateDetail }) {
  const t = useTranslations("mandate.ledger");
  const bars = detail.mandate.authority.filter(
    (a) => a.perPeriod !== null && a.settledRatio !== null,
  );
  return (
    <section
      aria-labelledby="mandate-ledger"
      data-testid="mandate-ledger"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="mandate-ledger" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      {detail.ledger.length === 0 ? (
        <StateWrap
          kind="empty"
          title={t("empty")}
          headingLevel={3}
          testId="mandate-empty"
        >
          {/* Deriving a Date from the answer's own `asOf` is a pure read of a
              prop, not a clock read in render. */}
          {isEffective(detail.mandate, new Date(detail.asOf))
            ? t("emptyBodyEffective")
            : t("emptyBody")}
        </StateWrap>
      ) : (
        <>
          <div
            className={`${panelBody} flex flex-col gap-4 border-b border-border`}
          >
            {bars.map((authority) => (
              <AuthorityBar
                key={authority.measure}
                authority={authority}
                named={bars.length > 1}
              />
            ))}
            <p className="text-[11.5px] text-dim">{t("concurrency")}</p>
          </div>
          {detail.readBound === null ? null : (
            <p
              data-state="read-bound"
              className="max-w-prose px-4 pt-3 text-xs text-foreground"
            >
              {t("readBound", { shown: String(detail.readBound) })}
            </p>
          )}
          <LedgerTable ledger={detail.ledger} />
          <div className="border-t border-border px-4 py-2.5">
            <NotBacked gap="G8" block>
              {t("footnote")}
            </NotBacked>
          </div>
        </>
      )}
    </section>
  );
}
