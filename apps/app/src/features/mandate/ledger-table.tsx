"use client";
// The ledger table (the design's table under the remaining-authority bar):
// every draw on this mandate, one row per call and measure in the state the
// call reached, with a search, a facet on State, a rows-per-page choice and a
// pager, all over the draws the page already read (view.ts says why that is
// the contract's shape).
//
// **State is a dot and a word.** A reservation, a settlement and a release are
// three facts about money, and a reader must be able to tell them apart in
// greyscale; the hue sits on the dot and the word carries the meaning.
//
// **Two cells say what is not recorded rather than filling in.** The ledger
// records the call by a raw id that no read resolves to a tool version (#3871),
// so the Call cell says the tool version is not recorded; and no read carries a
// receipt frame (#3869), so a settled or released draw's Receipt cell says the
// receipt is not recorded. A reservation has no receipt yet and shows the
// design's dash. Nothing prints a uuid or a zero in their place.
//
// **A draw from an earlier window is marked.** The Settled tile counts this
// period (`periodKey`), and the table lists the newest draws across every
// period, so a settled row from an earlier window says so under its date rather
// than reading as part of a total it is not in.
import { useTimeZone, useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { MandateDraw, MandateMovement } from "@/data/contracts/mandates";
import { Badge, type BadgeTone } from "@/ui/badge";
import { inputBase, mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Measure, NamedMeasure } from "@/ui/measure";
import { cell, headCell, numericCell } from "@/ui/table";
import { NotBacked } from "./state";
import {
  DEFAULT_PAGE_SIZE,
  type LedgerView,
  ledgerPage,
  MOVEMENT_STATES,
  nextSort,
  PAGE_SIZES,
  type PageSize,
  type SortableColumn,
  whenOf,
} from "./view";

/** The design's badge per state: settled reads allowed, reserved approval, released denied. */
const TONE: Record<MandateMovement, BadgeTone> = {
  settle: "allowed",
  reserve: "approval",
  release: "denied",
};

// 16px on a phone, as the design's inputs are, so iOS does not zoom the page.
const toolbarControl = `${inputBase} max-md:min-h-11 max-md:text-base`;

/** At most five page buttons, centred on the current page where there is room. */
function pageWindow(current: number, pages: number): number[] {
  const start = Math.max(0, Math.min(current - 2, pages - 5));
  const end = Math.min(pages, start + 5);
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function ExternalCell({ row }: { row: MandateDraw }) {
  const t = useTranslations("mandate.ledger");
  if (row.externalEffectRef !== null)
    return (
      <span className={`${mono} break-all text-xs`}>
        {row.externalEffectRef}
      </span>
    );
  // A reservation has caused no effect yet and a release never will; only a
  // settlement without a reference is a missing fact.
  const key =
    row.state === "reserve"
      ? "noEffectYet"
      : row.state === "release"
        ? "releasedNoEffect"
        : "notRecorded";
  return <span className="text-xs text-muted-foreground">{t(key)}</span>;
}

/** The design's When cell: the time for today's draw, the day for an older one. */
function WhenCell({
  row,
  asOf,
  current,
}: {
  row: MandateDraw;
  asOf: string;
  current: boolean;
}) {
  const t = useTranslations("mandate.ledger");
  const format = useFormatter();
  const timeZone = useTimeZone();
  const when = timeZone === undefined ? null : whenOf(row.at, asOf, timeZone);
  return (
    <>
      <time dateTime={row.at} className={`${mono} text-[11.5px]`}>
        {when === null
          ? format.dateTime(new Date(row.at), {
              dateStyle: "medium",
              timeStyle: "medium",
            })
          : when.text}
      </time>
      {current ? null : (
        <span
          data-state="earlier-period"
          className="block text-[11px] text-muted-foreground"
        >
          {t("earlierPeriod", { period: row.periodKey })}
        </span>
      )}
    </>
  );
}

export function LedgerTable({
  draws,
  asOf,
  primary,
  periodKeys,
}: {
  draws: readonly MandateDraw[];
  /** When the ledger answered: a draw on that day shows its time. */
  asOf: string;
  /** The measure the tiles speak for; a draw on another measure is named. */
  primary: string | null;
  /** The window each measure's authority counts now, by measure. */
  periodKeys: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("mandate.ledger");
  const id = useId();
  const [view, setView] = useState<LedgerView>({
    search: "",
    state: null,
    size: DEFAULT_PAGE_SIZE,
    page: 0,
  });
  const page = ledgerPage(draws, view);
  // Call and Receipt hold no recorded value yet (#3871, #3869), so their
  // headers do not sort; the other four sort on the value the cell prints.
  const columns: {
    label: string;
    numeric?: boolean;
    sort?: SortableColumn;
  }[] = [
    { label: t("columns.when"), sort: "when" },
    { label: t("columns.call") },
    { label: t("columns.amount"), numeric: true, sort: "amount" },
    { label: t("columns.state"), sort: "state" },
    { label: t("columns.external"), sort: "external" },
    { label: t("columns.receipt") },
  ];
  const set = (next: Partial<LedgerView>) => {
    // Any change but a page turn starts again from the first page, so a
    // narrower search never lands on a page past its end.
    setView((was) => ({ ...was, page: 0, ...next }));
  };

  return (
    <>
      <div
        data-testid="ledger-toolbar"
        className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-2.5"
      >
        <input
          type="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={view.search}
          onChange={(event) => {
            set({ search: event.target.value });
          }}
          className={`${toolbarControl} min-w-40 flex-1`}
        />
        <select
          aria-label={t("state")}
          value={view.state ?? ""}
          onChange={(event) => {
            set({
              state:
                MOVEMENT_STATES.find((s) => s === event.target.value) ?? null,
            });
          }}
          className={`${toolbarControl} w-auto`}
        >
          <option value="">{t("allStates")}</option>
          {MOVEMENT_STATES.map((state) => (
            <option key={state} value={state}>
              {t(`kind.${state}`)}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-rows`} className="text-xs text-muted-foreground">
          {t("rows")}
        </label>
        <select
          id={`${id}-rows`}
          value={String(view.size)}
          onChange={(event) => {
            const size = PAGE_SIZES.find(
              (s) => String(s) === event.target.value,
            );
            set({ size: size ?? DEFAULT_PAGE_SIZE });
          }}
          className={`${toolbarControl} w-auto`}
        >
          {PAGE_SIZES.map((size: PageSize) => (
            <option key={size} value={String(size)}>
              {size === 0 ? t("all") : String(size)}
            </option>
          ))}
        </select>
      </div>
      {page.rows.length === 0 ? (
        <p
          data-state="filtered-empty"
          className="px-4 py-8 text-center text-sm text-muted-foreground"
        >
          {t("filteredEmpty")}
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-label={t("label")}
            className="w-full min-w-[560px] border-collapse text-[13px]"
          >
            <thead>
              <tr className="border-b border-border">
                {columns.map((column) => {
                  const align =
                    column.numeric === true ? "text-right" : "text-left";
                  if (column.sort === undefined)
                    return (
                      <th
                        key={column.label}
                        scope="col"
                        className={`${headCell} ${align}`}
                      >
                        {column.label}
                      </th>
                    );
                  const key = column.sort;
                  const state =
                    view.sort?.column === key
                      ? view.sort.dir === 1
                        ? "ascending"
                        : "descending"
                      : "none";
                  return (
                    <th
                      key={column.label}
                      scope="col"
                      aria-sort={state}
                      className={`${headCell} ${align}`}
                    >
                      <button
                        type="button"
                        data-sort={state}
                        onClick={() => {
                          set({ sort: nextSort(view.sort, key) });
                        }}
                        className="inline-flex cursor-pointer select-none items-center uppercase tracking-[inherit] hover:text-muted-foreground data-[sort=ascending]:text-foreground data-[sort=descending]:text-foreground after:ml-[5px] after:text-[10px] after:text-rule after:content-['↕'] data-[sort=ascending]:after:text-accent-text data-[sort=ascending]:after:content-['↑'] data-[sort=descending]:after:text-accent-text data-[sort=descending]:after:content-['↓']"
                      >
                        {column.label}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
              {page.rows.map((row, index) => (
                <tr
                  // A draw carries no public id and a raw uuid never reaches a
                  // view model, so the key is the row's place in a list the
                  // server ordered.
                  key={`${row.at}-${row.state}-${row.measure}-${String(page.from + index)}`}
                  data-testid="ledger-draw"
                  data-state={row.state}
                >
                  <td className={`${cell} whitespace-nowrap`}>
                    <WhenCell
                      row={row}
                      asOf={asOf}
                      current={periodKeys[row.measure] === row.periodKey}
                    />
                  </td>
                  <td className={cell}>
                    <NotBacked gap="tool-version">
                      {t("callNotRecorded")}
                    </NotBacked>
                  </td>
                  <td className={numericCell}>
                    {row.measure === primary ? (
                      <Measure value={row.value} />
                    ) : (
                      <NamedMeasure measure={row.measure} value={row.value} />
                    )}
                  </td>
                  <td className={cell}>
                    <Badge tone={TONE[row.state]}>
                      {t(`kind.${row.state}`)}
                    </Badge>
                  </td>
                  <td className={cell}>
                    <ExternalCell row={row} />
                  </td>
                  <td className={cell}>
                    {row.state === "reserve" ? (
                      <span
                        data-state="no-receipt-yet"
                        className="text-muted-foreground"
                      >
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">{t("noReceiptYet")}</span>
                      </span>
                    ) : (
                      <NotBacked gap="G8">{t("notRecorded")}</NotBacked>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav
        aria-label={t("pager.label")}
        className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
      >
        <span className={mono} data-testid="ledger-range">
          {t("range", {
            from: String(page.from),
            to: String(page.to),
            total: String(page.total),
          })}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("pager.previous")}
            disabled={page.page === 0}
            onClick={() => {
              setView((was) => ({ ...was, page: page.page - 1 }));
            }}
            className="grid size-7 place-items-center rounded-md border border-border disabled:opacity-45 max-md:size-11"
          >
            ‹
          </button>
          {pageWindow(page.page, page.pages).map((index) => (
            <button
              key={index}
              type="button"
              aria-label={t("pager.page", { page: String(index + 1) })}
              aria-current={index === page.page ? "page" : undefined}
              onClick={() => {
                setView((was) => ({ ...was, page: index }));
              }}
              className="grid size-7 place-items-center rounded-md border border-border font-mono aria-[current=page]:border-gold aria-[current=page]:text-foreground max-md:size-11"
            >
              {String(index + 1)}
            </button>
          ))}
          <button
            type="button"
            aria-label={t("pager.next")}
            disabled={page.page >= page.pages - 1}
            onClick={() => {
              setView((was) => ({ ...was, page: page.page + 1 }));
            }}
            className="grid size-7 place-items-center rounded-md border border-border disabled:opacity-45 max-md:size-11"
          >
            ›
          </button>
        </span>
      </nav>
    </>
  );
}
