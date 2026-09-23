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
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type {
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
import { Instant } from "./figures";
import { PriceDialog } from "./price-dialog";
import { RemoveRateDialog } from "./remove-rate-dialog";
import { SpendReadFailure } from "./states";
import { Empty, HeaderCell, Panel } from "./tables";
import type { SpendAt } from "./view";

const cell = "px-4 py-2 text-left align-top";

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
      <span className="block text-xs text-muted-foreground">
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
  if (!read.ok) return <SpendReadFailure read={read} />;
  const { models, since } = read.value;
  // Nothing unpriced is the good case and gets one quiet line, never an empty
  // box competing with the book below it for attention.
  if (models.length === 0) {
    return (
      <p
        data-state="empty"
        data-testid="unpriced-none"
        className="text-sm text-muted-foreground"
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
      <table className="w-full text-sm">
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
                <span className="flex flex-wrap gap-1">
                  {model.missingClasses.map((tokenClass) => (
                    <span
                      key={tokenClass}
                      data-class={tokenClass}
                      className="rounded border border-border px-1.5 py-0.5 text-xs"
                    >
                      {t(`class.${tokenClass}`)}
                    </span>
                  ))}
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
        <SpendReadFailure read={read} />
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
          <h3 className="px-4 py-3 text-sm font-medium">
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
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(entries.length / 100));
  const current = Math.min(page, pages - 1);
  const visible = entries.slice(current * 100, (current + 1) * 100);
  return (
    <>
      {entries.length === 0 ? (
        <Empty>{t("book.empty")}</Empty>
      ) : (
        <table className="w-full text-sm">
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
                  <span className="inline-flex flex-wrap items-baseline gap-x-2">
                    <Money value={entry.ratePerMillion} precision="exact" />
                    <span className="text-xs text-muted-foreground">
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
                        ? "rounded border border-success/45 bg-success/10 px-1.5 py-0.5 text-xs font-medium text-foreground"
                        : "text-xs text-muted-foreground"
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
                    <span className="text-xs text-muted-foreground">
                      {t("book.platformPriced")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pages > 1 ? (
        <nav
          aria-label={t("book.pagination")}
          className="flex items-center justify-between px-4 py-2"
        >
          <button
            type="button"
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            {t("book.previous")}
          </button>
          <span>{t("book.page", { page: current + 1, pages })}</span>
          <button
            type="button"
            disabled={current + 1 === pages}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            {t("book.next")}
          </button>
        </nav>
      ) : null}
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
