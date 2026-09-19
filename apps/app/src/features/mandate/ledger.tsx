// The ledger of every draw on one mandate: what was held at decision time, what
// was spent, what was handed back. Search, a facet on the movement state, and a
// pager, all over the rows `get_mandate` returned (see view.ts for why that is
// the contract's shape rather than a shortcut).
//
// **State is a dot and a word.** A reservation, a settlement and a release are
// three different facts about money, and a reader must be able to tell them
// apart in greyscale, on a projector, and with any colour vision. The hue sits
// on the dot; the word carries the meaning; nothing on this table is
// distinguished by colour alone.
//
// **Two columns say what is not recorded rather than filling in.** *Call* names
// the measure the movement drew, because the ledger records the call by a raw
// identifier and no read resolves it to a tool version; *Receipt* is empty
// because receipt frames have no read yet. Each is explained once beneath the
// table rather than repeated on every row, and neither prints a uuid or a zero
// in place of a fact nobody recorded.
import { useFormatter, useTranslations } from "next-intl";
import type { MandateDetail, MandateMovement } from "@/data/contracts/mandates";
import { linkText, mono, panel } from "@/ui/control-styles";
import { Measure } from "@/ui/measure";
import { SafeForm, SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import {
  LEDGER_PAGE,
  ledgerPage,
  type MandateAt,
  mandateLink,
  type MandateView,
  MOVEMENT_STATES,
} from "./view";

/** The hue each movement carries, on the dot alone. */
const DOT: Record<MandateMovement, string> = {
  reserve: "bg-warning",
  settle: "bg-success",
  release: "bg-muted-foreground",
};

function MovementState({ kind }: { kind: MandateMovement }) {
  const t = useTranslations("mandate.ledger.kind");
  return (
    <span
      data-state={kind}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[kind]}`} />
      {t(kind)}
    </span>
  );
}

const field = "flex min-w-40 flex-col gap-1 text-sm";
const fieldLabel = "text-xs font-medium text-muted-foreground";
const control =
  "min-h-10 rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-sm text-input-fg focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring";

function Filters({ at, view }: { at: MandateAt; view: MandateView }) {
  const t = useTranslations("mandate.ledger");
  return (
    <SafeForm
      action={mandateLink(at)}
      method="get"
      aria-label={t("label")}
      data-testid="ledger-filters"
      className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3"
    >
      <span className={field}>
        <label className={fieldLabel} htmlFor="ledger-search">
          {t("search")}
        </label>
        <input
          id="ledger-search"
          name="q"
          defaultValue={view.search ?? ""}
          className={control}
        />
      </span>
      <span className={field}>
        <label className={fieldLabel} htmlFor="ledger-state">
          {t("state")}
        </label>
        <select
          id="ledger-state"
          name="state"
          defaultValue={view.state ?? ""}
          className={control}
        >
          <option value="">{t("anyState")}</option>
          {MOVEMENT_STATES.map((state) => (
            <option key={state} value={state}>
              {t(`kind.${state}`)}
            </option>
          ))}
        </select>
      </span>
      <button type="submit" className={`${control} font-medium`}>
        {t("apply")}
      </button>
      {view.search === null && view.state === null ? null : (
        <SafeLink to={mandateLink(at)} className={linkText}>
          {t("clear")}
        </SafeLink>
      )}
      <p className="ms-auto text-xs text-muted-foreground">{t("searchHint")}</p>
    </SafeForm>
  );
}

export function MandateLedger({
  detail,
  at,
  view,
}: {
  detail: MandateDetail;
  at: MandateAt;
  view: MandateView;
}) {
  const t = useTranslations("mandate.ledger");
  const format = useFormatter();
  const page = ledgerPage(detail.ledger, view);
  const columns = [
    { label: t("columns.when") },
    { label: t("columns.call") },
    { label: t("columns.amount"), numeric: true },
    { label: t("columns.state") },
    { label: t("columns.external") },
    { label: t("columns.receipt") },
  ];
  return (
    <section
      aria-labelledby="mandate-ledger"
      className={panel}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-4">
        <h2 id="mandate-ledger" className="text-base font-semibold">
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("basis")}</p>
      </div>
      <p className="px-4 pb-3 text-xs text-muted-foreground">{t("note")}</p>
      {detail.truncatedAt === null ? null : (
        <p
          data-state="truncated"
          className="max-w-prose px-4 pb-3 text-sm text-foreground"
        >
          {t("truncated", { shown: String(detail.truncatedAt) })}
        </p>
      )}
      <Filters at={at} view={view} />
      {detail.ledger.length === 0 ? (
        <div data-state="empty" className="flex flex-col gap-2 px-4 py-8">
          <h3 className="text-base font-semibold">{t("empty")}</h3>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t("emptyBody")}
          </p>
        </div>
      ) : page.rows.length === 0 ? (
        <div
          data-state="filtered-empty"
          className="flex flex-col items-start gap-2 px-4 py-8"
        >
          <h3 className="text-base font-semibold">{t("filteredEmpty")}</h3>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t("filteredEmptyBody")}
          </p>
          <SafeLink to={mandateLink(at)} className={linkText}>
            {t("clear")}
          </SafeLink>
        </div>
      ) : (
        <>
          <Table label={t("label")} columns={columns}>
            {page.rows.map((row, index) => (
              <tr
                // The ledger row carries no public id and a raw uuid never
                // reaches a view model (`MandateLedgerRow`), so the key is the
                // row's place in a list the server ordered and rendered in one
                // pass. Nothing here reorders on the client.
                // biome-ignore lint/suspicious/noArrayIndexKey: the row has no identifier the view model may carry
                key={`${row.at}-${row.kind}-${row.measure}-${String(index)}`}
                data-testid="ledger-movement"
                data-state={row.kind}
              >
                <td className={`${cell} whitespace-nowrap`}>
                  <span className={mono}>
                    {format.dateTime(new Date(row.at), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </td>
                <td className={cell}>
                  <span className={mono}>{row.measure}</span>
                  <div className="text-xs text-muted-foreground">
                    {row.periodKey}
                  </div>
                </td>
                <td className={numericCell}>
                  <Measure value={row.value} />
                </td>
                <td className={cell}>
                  <MovementState kind={row.kind} />
                </td>
                <td className={cell}>
                  {row.externalEffectId === null ? (
                    <span className="text-xs text-muted-foreground">
                      {t("notRecorded")}
                    </span>
                  ) : (
                    <span className={`${mono} break-all text-xs`}>
                      {row.externalEffectId}
                    </span>
                  )}
                </td>
                <td className={cell}>
                  <span
                    data-receipt="not-recorded"
                    className="text-xs text-muted-foreground"
                  >
                    {t("notRecorded")}
                  </span>
                </td>
              </tr>
            ))}
          </Table>
          <nav
            aria-label={t("pager.label")}
            className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-3 text-sm"
          >
            <span className="text-muted-foreground">
              {t("shown", {
                shown: String(page.rows.length),
                total: String(page.total),
              })}
            </span>
            {page.offset > 0 ? (
              <SafeLink
                to={mandateLink(at, {
                  ...view,
                  offset: Math.max(page.offset - LEDGER_PAGE, 0),
                })}
                data-page="newer"
                className={linkText}
              >
                {t("pager.newer")}
              </SafeLink>
            ) : null}
            {page.hasMore ? (
              <SafeLink
                to={mandateLink(at, {
                  ...view,
                  offset: page.offset + LEDGER_PAGE,
                })}
                data-page="older"
                className={linkText}
              >
                {t("pager.older")}
              </SafeLink>
            ) : (
              <span className="text-muted-foreground">{t("pager.end")}</span>
            )}
          </nav>
        </>
      )}
      <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <p className="max-w-prose">{t("callBasis")}</p>
        <p className="max-w-prose">{t("receiptBasis")}</p>
      </div>
    </section>
  );
}
