// The Ledger panel, left of the grant (the design's `pMandate`): the
// remaining-authority bar for each measure with a period limit, the sentence on
// why two calls cannot both fit under one remaining limit, then the table of
// every draw.
//
// A mandate in effect that has never been drawn on shows the design's empty
// state in place of the whole page body (mandate.tsx). One that is not in
// effect keeps its header and this panel, which says the undrawn limit
// authorizes nothing: enforcement honours only an active mandate inside its
// half-open window (`isEffective`), so a draft, revoked, expired or
// not-yet-started mandate has no remaining authority however much of its limit
// is undrawn, and a draft still needs its Decline.
import { useTranslations } from "next-intl";
import type { MandateDetail } from "@/data/contracts/mandates";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { AuthorityBar } from "./authority-bar";
import { LedgerTable } from "./ledger-table";
import { StateWrap } from "./state";
import { measuresOf, openCalls } from "./view";

export function MandateLedger({ detail }: { detail: MandateDetail }) {
  const t = useTranslations("mandate.ledger");
  const { mandate, draws } = detail;
  const bars = mandate.authority.filter(
    (a) => a.perPeriod !== null && a.settledRatio !== null,
  );
  const periodKeys = Object.fromEntries(
    mandate.authority.map((a) => [a.measure, a.periodKey]),
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
      {draws.length === 0 ? (
        <StateWrap
          kind="empty"
          title={t("empty")}
          headingLevel={3}
          testId="mandate-empty"
        >
          {t("emptyBody")}
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
                openCalls={openCalls(
                  draws,
                  authority.measure,
                  detail.readBound,
                )}
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
          <LedgerTable
            draws={draws}
            asOf={detail.asOf}
            primary={measuresOf(mandate).primary?.measure ?? null}
            periodKeys={periodKeys}
          />
        </>
      )}
    </section>
  );
}
