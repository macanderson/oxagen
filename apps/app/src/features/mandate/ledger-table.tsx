"use client";
// The ledger table (the design's table under the remaining-authority bar):
// every draw on this mandate, with a search, a facet on State, a rows-per-page
// choice and a pager, all over the rows the page already read (view.ts says why
// that is the contract's shape).
//
// **State is a dot and a word.** A reservation, a settlement and a release are
// three facts about money, and a reader must be able to tell them apart in
// greyscale; the hue sits on the dot and the word carries the meaning.
//
// **Two cells say what is not recorded rather than filling in.** The ledger
// records the call by a raw id that no read resolves to a tool version, so the
// Call column names the measure the draw counted; and no read carries a receipt
// frame, so no receipt opens from this table. Each is a `NotBacked` cell and the
// footnote names both gaps, so nothing prints a uuid or a zero in their place.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type {
  MandateLedgerRow,
  MandateMovement,
} from "@/data/contracts/mandates";
import { Badge, type BadgeTone } from "@/ui/badge";
import { inputBase, mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Measure } from "@/ui/measure";
import { cell, numericCell, Table } from "@/ui/table";
import { NotBacked } from "./state";
import {
  DEFAULT_PAGE_SIZE,
  type LedgerView,
  ledgerPage,
  MOVEMENT_STATES,
  PAGE_SIZES,
  type PageSize,
} from "./view";

/** The design's badge per state: settled reads allowed, reserved approval, released denied. */
const TONE: Record<MandateMovement, BadgeTone> = {
  settle: "allowed",
  reserve: "approval",
  release: "denied",
};

// 16px on a phone, as the design's inputs are, so iOS does not zoom the page.
const toolbarControl = `${inputBase} max-md:text-base`;

/** At most five page buttons, centred on the current page where there is room. */
function pageWindow(current: number, pages: number): number[] {
  const start = Math.max(0, Math.min(current - 2, pages - 5));
  const end = Math.min(pages, start + 5);
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function ExternalCell({ row }: { row: MandateLedgerRow }) {
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
    row.kind === "reserve"
      ? "noEffectYet"
      : row.kind === "release"
        ? "releasedNoEffect"
        : "notRecorded";
  return <span className="text-xs text-muted-foreground">{t(key)}</span>;
}

export function LedgerTable({
  ledger,
}: {
  ledger: readonly MandateLedgerRow[];
}) {
  const t = useTranslations("mandate.ledger");
  const format = useFormatter();
  const id = useId();
  const [view, setView] = useState<LedgerView>({
    search: "",
    state: null,
    size: DEFAULT_PAGE_SIZE,
    page: 0,
  });
  const page = ledgerPage(ledger, view);
  const columns = [
    { label: t("columns.when") },
    { label: t("columns.call") },
    { label: t("columns.amount"), numeric: true },
    { label: t("columns.state") },
    { label: t("columns.external") },
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
        <Table label={t("label")} columns={columns}>
          {page.rows.map((row, index) => (
            <tr
              // The ledger row carries no public id and a raw uuid never
              // reaches a view model, so the key is the row's place in a list
              // the server ordered.
              key={`${row.at}-${row.kind}-${row.measure}-${String(page.from + index)}`}
              data-testid="ledger-movement"
              data-state={row.kind}
            >
              <td className={`${cell} whitespace-nowrap`}>
                <span className={`${mono} text-[11.5px]`}>
                  {format.dateTime(new Date(row.at), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </td>
              <td className={cell}>
                <span className={`${mono} text-[11.5px]`}>{row.measure}</span>
              </td>
              <td className={numericCell}>
                <Measure value={row.value} />
              </td>
              <td className={cell}>
                <Badge tone={TONE[row.kind]}>{t(`kind.${row.kind}`)}</Badge>
              </td>
              <td className={cell}>
                <ExternalCell row={row} />
              </td>
              <td className={cell}>
                <NotBacked gap="G8">{t("notRecorded")}</NotBacked>
              </td>
            </tr>
          ))}
        </Table>
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
