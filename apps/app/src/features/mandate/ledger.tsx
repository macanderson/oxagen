// The ledger of every draw on one mandate: what was held at decision time, what
// was spent, what was handed back. Search, a facet on the movement state, and a
// pager with Rows per page beside Newer and Older (#4693), all over the rows
// `get_mandate` returned (see view.ts for why that is the contract's shape
// rather than a shortcut).
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
import { useTranslations } from "next-intl";
import {
  isEffective,
  type MandateDetail,
  type MandateMovement,
} from "@/data/contracts/mandates";
import { linkText, mono, panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { LinkPager } from "@/ui/link-pager";
import { Measure } from "@/ui/measure";
import { SafeForm, SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { LedgerStateSelect } from "./ledger-state-select";
import {
  LEDGER_PAGE,
  LEDGER_ROWS,
  type LedgerPage,
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
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${DOT[kind]}`}
      />
      <span className="min-w-0 md:truncate">{t(kind)}</span>
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
      {/* A get form sends its fields and drops the action's query, so the
          size Rows set rides along here, or a search would reset it (#4693). */}
      {view.rows === LEDGER_PAGE ? null : (
        <input type="hidden" name="rows" value={String(view.rows)} />
      )}
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
        <span id="ledger-state-label" className={fieldLabel}>
          {t("state")}
        </span>
        <LedgerStateSelect
          key={view.state ?? ""}
          id="ledger-state"
          aria-labelledby="ledger-state-label"
          defaultValue={view.state ?? ""}
          items={[
            { value: "", label: t("anyState") },
            ...MOVEMENT_STATES.map((state) => ({
              value: state,
              label: t(`kind.${state}`),
            })),
          ]}
          className="w-full data-[size=default]:h-10 max-md:text-base"
        />
      </span>
      <button type="submit" className={`${control} font-medium`}>
        {t("apply")}
      </button>
      {view.search === null && view.state === null ? null : (
        <SafeLink
          to={mandateLink(at, { rows: view.rows })}
          className={linkText}
        >
          {t("clear")}
        </SafeLink>
      )}
      <p className="ms-auto text-xs text-muted-foreground">{t("searchHint")}</p>
    </SafeForm>
  );
}

/**
 * The pager under the table (#4693): Rows per page and the count on the left,
 * Newer and Older on the right. The ledger reads newest first, so the page
 * before this one is the newer one. Every address keeps the search, the facet
 * and the size, and each size Rows offers opens its own first page.
 */
function Pager({
  at,
  view,
  page,
}: {
  at: MandateAt;
  view: MandateView;
  page: LedgerPage;
}) {
  const t = useTranslations("mandate.ledger");
  const list = useTranslations("ui.list");
  return (
    <LinkPager
      label={t("pager.label")}
      rowsLabel={list("rows")}
      previousLabel={t("pager.newer")}
      nextLabel={t("pager.older")}
      perPage={view.rows}
      sizes={LEDGER_ROWS.map((size) => ({
        size,
        first: mandateLink(at, { ...view, rows: size, offset: 0 }),
      }))}
      range={t("shown", {
        shown: String(page.rows.length),
        total: String(page.total),
      })}
      previous={
        page.offset > 0
          ? mandateLink(at, {
              ...view,
              offset: Math.max(page.offset - view.rows, 0),
            })
          : null
      }
      next={
        page.hasMore
          ? mandateLink(at, { ...view, offset: page.offset + view.rows })
          : null
      }
      className="border-t border-border px-4"
    />
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
    <section aria-labelledby="mandate-ledger" className={panel}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-4">
        <h2 id="mandate-ledger" className="text-base font-semibold">
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("basis")}</p>
      </div>
      <p className="px-4 pb-3 text-xs text-muted-foreground">{t("note")}</p>
      {detail.readBound === null ? null : (
        <p
          data-state="read-bound"
          className="max-w-prose px-4 pb-3 text-sm text-foreground"
        >
          {t("readBound", { shown: String(detail.readBound) })}
        </p>
      )}
      <Filters at={at} view={view} />
      {detail.ledger.length === 0 ? (
        <div data-state="empty" className="flex flex-col gap-2 px-4 py-8">
          <h3 className="text-base font-semibold">{t("empty")}</h3>
          <p className="max-w-prose text-sm text-muted-foreground">
            {/* An empty ledger does not mean the limits are live authority.
                Enforcement honours only an active mandate inside its half-open
                window (`isEffective`), so a draft, revoked, expired or
                not-yet-started mandate has no remaining authority however much
                of its recorded period limit is undrawn. The stronger sentence
                is reserved for the case where it is true. Deriving a Date from
                the answer's own `asOf` is a pure read of a prop, not a clock
                read in render. */}
            {isEffective(detail.mandate, new Date(detail.asOf))
              ? t("emptyBodyEffective")
              : t("emptyBody")}
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
          <SafeLink
            to={mandateLink(at, { rows: view.rows })}
            className={linkText}
          >
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
                  <div className="text-xs text-muted-foreground md:truncate">
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
                  {row.externalEffectRef === null ? (
                    <span className="text-xs text-muted-foreground">
                      {t("notRecorded")}
                    </span>
                  ) : (
                    <span className={`${mono} text-xs`}>
                      {row.externalEffectRef}
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
          <Pager at={at} view={view} page={page} />
        </>
      )}
      <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <p className="max-w-prose">{t("callBasis")}</p>
        <p className="max-w-prose">{t("receiptBasis")}</p>
      </div>
    </section>
  );
}
