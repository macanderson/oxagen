"use client";
// The price book this organization is priced against, and the models it
// cannot price (Mission Control spec §12.2, ADR-060 §1). The tab leads with
// the unpriced models because they are the answer to "why does this run have
// no cost": a model the book cannot price at all leaves its frames with no
// cost recorded, and one it prices only in part leaves them `estimated`.
// Neither is free, and neither is ever drawn as a zero (INV-09).
//
// The two reads are independent, so one failing does not blank the tab: each
// half renders its own answer, its own empty state or its own refusal.
//
// Each price table pages in the browser, with Rows per page beside Previous
// and Next at its foot (#4693).
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type {
  MissingClassWindow,
  PriceBook,
  PriceEntry,
  PriceTokenClass,
  UnpricedModels,
} from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { RowsPager } from "@/ui/pagination";
import { Instant } from "./figures";
import { PriceDialog } from "./price-dialog";
import { RemoveRateDialog } from "./remove-rate-dialog";
import { SpendSectionFailure } from "./states";
import { Empty, HeaderCell, Panel } from "./tables";
import type { SpendAt } from "./view";

const cell = "px-4 py-2 text-left align-top";

/**
 * The sizes Rows per page offers under each price table (#4693). A table opens
 * at 100 rows, the size the book paged by before a reader could choose one.
 */
const BOOK_ROWS: readonly number[] = [10, 25, 50, 100];
const BOOK_DEFAULT_ROWS = 100;

/**
 * The order the classes read in: what a call sent, what it read back out of
 * the cache, what it wrote into one, what it answered, then the classes that
 * are not tokens. It is the contract's own order, and it is what sorts a
 * model's rows so its classes read together.
 */
const CLASS_ORDER: readonly PriceTokenClass[] = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
];

const classRank = (tokenClass: PriceTokenClass): number => {
  const at = CLASS_ORDER.indexOf(tokenClass);
  return at === -1 ? CLASS_ORDER.length : at;
};

/**
 * A model's rows together, vendor by vendor, each model's classes in the order
 * above — so the book reads as rate cards rather than as a scatter of rows.
 * The organization's own rows come before the list row they beat, since that
 * is the pair a person is comparing.
 */
function sorted(entries: readonly PriceEntry[]): PriceEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      (a.region ?? "").localeCompare(b.region ?? "") ||
      classRank(a.tokenClass) - classRank(b.tokenClass) ||
      Number(b.negotiated) - Number(a.negotiated),
  );
}

/** A row's key: the tuple `cost.price_entries` arbitrates on, plus which book it came from. */
const keyOf = (entry: PriceEntry): string =>
  [
    entry.provider,
    entry.model,
    entry.tokenClass,
    entry.region ?? "",
    entry.source,
    entry.effectiveFrom,
  ].join("|");

/** When a row started, and whether it is still open or when it stopped. */
function Effective({ entry }: { entry: PriceEntry }) {
  const t = useTranslations("spend.pricing");
  const format = useFormatter();
  return (
    <>
      <Instant iso={entry.effectiveFrom} />
      <span className="block text-sm text-muted-foreground md:truncate">
        {entry.effectiveTo === null
          ? t("book.open")
          : t("book.until", {
              day: format.dateTime(new Date(entry.effectiveTo), {
                dateStyle: "medium",
              }),
            })}
      </span>
    </>
  );
}

/**
 * How much of one class ran unpriced, and when: the calls, their tokens (or
 * requests, for server tool requests), and the span of those calls. A rate
 * that starts after the first of them leaves them unpriced, which is the
 * blank a run's cost shows (#3281).
 */
function WindowLine({ usage }: { usage: MissingClassWindow }) {
  const t = useTranslations("spend.pricing");
  const format = useFormatter();
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  const values = {
    calls: usage.calls,
    units: usage.units,
    from: day(usage.from),
    to: day(usage.to),
  };
  return (
    <span
      data-window={usage.tokenClass}
      className="block text-sm text-muted-foreground md:truncate"
    >
      {usage.tokenClass === "server_tool_request"
        ? t("unpriced.windowRequests", values)
        : t("unpriced.windowTokens", values)}
    </span>
  );
}

/**
 * The models the book cannot price. This is the section that explains a blank
 * cost, so it says what the blank means — no cost at all, or a cost the
 * rollup could only estimate — and offers the rate that fixes it.
 */
function UnpricedSection({
  read,
  at,
}: {
  read: Read<UnpricedModels>;
  at: SpendAt;
}) {
  const t = useTranslations("spend.pricing");
  const locale = useLocale();
  const format = useFormatter();
  if (!read.ok) return <SpendSectionFailure read={read} />;
  const { models, since } = read.value;
  // Nothing unpriced is the good case and gets one quiet line, never an empty
  // box competing with the book below it for attention.
  if (models.length === 0) {
    return (
      <p
        data-state="empty"
        data-testid="unpriced-none"
        className="text-base text-muted-foreground"
      >
        {t("unpriced.none", {
          since: format.dateTime(new Date(since), { dateStyle: "medium" }),
        })}
      </p>
    );
  }
  return (
    <Panel
      id="spend-unpriced"
      title={t("unpriced.title")}
      footer={t("unpriced.note", {
        since: format.dateTime(new Date(since), { dateStyle: "medium" }),
      })}
    >
      <table className="w-full text-base">
        <thead>
          <tr>
            <HeaderCell>{t("unpriced.columns.model")}</HeaderCell>
            <HeaderCell>{t("unpriced.columns.provider")}</HeaderCell>
            <HeaderCell>{t("unpriced.columns.calls")}</HeaderCell>
            <HeaderCell>{t("unpriced.columns.tokens")}</HeaderCell>
            <HeaderCell>{t("unpriced.columns.missing")}</HeaderCell>
            <HeaderCell>{t("unpriced.columns.recordedAs")}</HeaderCell>
            <HeaderCell>{t("unpriced.columns.action")}</HeaderCell>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr
              key={model.model}
              data-model={model.model}
              data-fully-unpriced={String(model.fullyUnpriced)}
            >
              <th scope="row" className={`${cell} font-normal`}>
                <span className={mono}>{model.model}</span>
              </th>
              <td className={cell}>
                {model.provider === null ? (
                  <span className="text-muted-foreground">
                    {t("unpriced.noProvider")}
                  </span>
                ) : (
                  model.provider
                )}
              </td>
              <td className={cell}>
                <span className="tabular-nums">
                  {formatCount(model.calls, locale)}
                </span>
              </td>
              <td className={cell}>
                <span className="tabular-nums">
                  {formatCount(model.tokens, locale)}
                </span>
              </td>
              <td className={cell}>
                <span className="flex flex-col gap-1.5">
                  {model.missingClasses.map((tokenClass) => {
                    const usage = model.missingClassWindows.find(
                      (w) => w.tokenClass === tokenClass,
                    );
                    return (
                      <span key={tokenClass}>
                        <span
                          data-class={tokenClass}
                          className="rounded border border-border px-1.5 py-0.5 text-sm"
                        >
                          {t(`class.${tokenClass}`)}
                        </span>
                        {usage === undefined ? null : (
                          <WindowLine usage={usage} />
                        )}
                      </span>
                    );
                  })}
                </span>
              </td>
              <td className={cell}>
                <span
                  className={
                    model.fullyUnpriced
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {model.fullyUnpriced
                    ? t("unpriced.noCost")
                    : t("unpriced.estimated")}
                </span>
              </td>
              <td className={cell}>
                <PriceDialog
                  at={at}
                  compact
                  prefill={{
                    provider: model.provider,
                    model: model.model,
                    classes: model.missingClasses,
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/** The book itself: every list price, and the organization's own rows that beat them. */
function PriceBookSection({
  read,
  at,
}: {
  read: Read<PriceBook>;
  at: SpendAt;
}) {
  const t = useTranslations("spend.pricing");
  const format = useFormatter();
  // A book that cannot be read is still a book that can be written to: the two
  // are separate capabilities, and a person who came here to state the rate
  // that fixes an unpriced model should not lose the way to do it because the
  // read is down.
  if (!read.ok) {
    return (
      <div className="flex flex-col gap-2">
        <SpendSectionFailure read={read} />
        <div className="flex justify-end">
          <PriceDialog at={at} />
        </div>
      </div>
    );
  }
  const entries = sorted(read.value.entries);
  return (
    <Panel
      id="spend-price-book"
      title={t("book.title")}
      footer={t("book.note", {
        at: format.dateTime(new Date(read.value.at), { dateStyle: "medium" }),
      })}
      action={<PriceDialog at={at} />}
    >
      <PriceTable
        entries={entries.filter(
          (entry) => entry.effectiveFrom <= read.value.at,
        )}
        at={at}
        scheduled={false}
      />
      {entries.some((entry) => entry.effectiveFrom > read.value.at) ? (
        <section aria-label={t("book.scheduled")}>
          <h3 className="px-4 py-3 text-base font-medium">
            {t("book.scheduled")}
          </h3>
          <PriceTable
            entries={entries.filter(
              (entry) => entry.effectiveFrom > read.value.at,
            )}
            at={at}
            scheduled
          />
        </section>
      ) : null}
    </Panel>
  );
}

function PriceTable({
  entries,
  at,
  scheduled,
}: {
  entries: PriceEntry[];
  at: SpendAt;
  scheduled: boolean;
}) {
  const t = useTranslations("spend.pricing");
  const list = useTranslations("ui.list");
  const locale = useLocale();
  const [perPage, setPerPage] = useState(BOOK_DEFAULT_ROWS);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(entries.length / perPage));
  const current = Math.min(page, pages - 1);
  const from = current * perPage;
  const visible = entries.slice(from, from + perPage);
  return (
    <>
      {entries.length === 0 ? (
        <Empty>{t("book.empty")}</Empty>
      ) : (
        <table className="w-full text-base">
          <thead>
            <tr>
              <HeaderCell>{t("book.columns.model")}</HeaderCell>
              <HeaderCell>{t("book.columns.provider")}</HeaderCell>
              <HeaderCell>{t("book.columns.tokenClass")}</HeaderCell>
              <HeaderCell>{t("book.columns.rate")}</HeaderCell>
              <HeaderCell>{t("book.columns.region")}</HeaderCell>
              <HeaderCell>{t("book.columns.source")}</HeaderCell>
              <HeaderCell>{t("book.columns.effective")}</HeaderCell>
              <HeaderCell>{t("book.columns.action")}</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr
                key={keyOf(entry)}
                data-model={entry.model}
                data-class={entry.tokenClass}
                data-source={entry.source}
                data-negotiated={String(entry.negotiated)}
              >
                <th scope="row" className={`${cell} font-normal`}>
                  <span className={mono}>{entry.model}</span>
                </th>
                <td className={cell}>{entry.provider}</td>
                <td className={cell}>{t(`class.${entry.tokenClass}`)}</td>
                <td className={cell}>
                  <span className="inline-flex items-baseline gap-x-2 max-md:flex-wrap">
                    <Money value={entry.ratePerMillion} precision="exact" />
                    <span className="text-sm text-muted-foreground">
                      {t(`per.${entry.unit}`)}
                    </span>
                  </span>
                </td>
                <td className={cell}>
                  {entry.region ?? (
                    <span className="text-muted-foreground">
                      {t("book.anyRegion")}
                    </span>
                  )}
                </td>
                <td className={cell}>
                  <span
                    className={
                      entry.negotiated
                        ? "rounded border border-success/45 bg-success/10 px-1.5 py-0.5 text-sm font-medium text-foreground"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {t(`source.${entry.source}`)}
                  </span>
                </td>
                <td className={cell}>
                  <Effective entry={entry} />
                </td>
                <td className={cell}>
                  {entry.negotiated &&
                  (!scheduled || entry.cancellationToken) ? (
                    <RemoveRateDialog
                      at={at}
                      entry={{
                        ...(scheduled && entry.cancellationToken
                          ? { cancellationToken: entry.cancellationToken }
                          : {}),
                        provider: entry.provider,
                        model: entry.model,
                        tokenClass: entry.tokenClass,
                        region: entry.region,
                      }}
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t("book.platformPriced")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* The pager draws under any table with a row, one page or many, so
          the size stays in reach. Changing the rows goes back to page 1. */}
      {entries.length === 0 ? null : (
        <RowsPager
          label={scheduled ? t("book.scheduledPages") : t("book.pages")}
          rowsLabel={list("rows")}
          perPage={perPage}
          sizes={BOOK_ROWS}
          onPerPage={(size) => {
            setPerPage(size);
            setPage(0);
          }}
          sizeLabel={(size) => formatCount(size, locale)}
          range={list("range", {
            from: formatCount(from + 1, locale),
            to: formatCount(from + visible.length, locale),
            total: formatCount(entries.length, locale),
          })}
          previousLabel={list("previous")}
          nextLabel={list("next")}
          previous={
            current <= 0
              ? null
              : () => {
                  setPage(current - 1);
                }
          }
          next={
            current >= pages - 1
              ? null
              : () => {
                  setPage(current + 1);
                }
          }
          className="border-t border-border px-4"
        />
      )}
    </>
  );
}

export function PricingSection({
  book,
  unpriced,
  at,
}: {
  book: Read<PriceBook>;
  unpriced: Read<UnpricedModels>;
  at: SpendAt;
}) {
  return (
    <>
      <UnpricedSection read={unpriced} at={at} />
      <PriceBookSection read={book} at={at} />
    </>
  );
}
