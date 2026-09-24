"use client";
// The ranked finding cards with the design's filters (spec "Findings"):
// Level, Confidence, Sort (Rank, Savings high first, Savings low first,
// Finding A to Z), Rows and a pager. Filtering runs over the open findings the
// server listed, largest saving first, so a finding's rank is its place in
// that list and never changes with a filter. Each card names who the finding
// is about, the finding, what it cites, the amount at stake and its share of
// the identified total, and opens Evidence and Fix.
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { byMicrosDescending } from "@/data/contracts/money";
import type { SpendFinding } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono, panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import {
  formatCount,
  formatMoney,
  formatRatio,
  ratioWidth,
} from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { FixDialog } from "./fix-dialog";
import type { SpendAt } from "./view";

const LEVELS = ["all", "agent", "operator", "tool", "workspace"] as const;
const CONFIDENCES = ["all", "high", "medium"] as const;
const SORTS = ["rank", "savingDesc", "savingAsc", "kind"] as const;
const PAGE_SIZES = [10, 25, 50] as const;

type Level = (typeof LEVELS)[number];
type Confidence = (typeof CONFIDENCES)[number];
type Sort = (typeof SORTS)[number];

type Ranked = { finding: SpendFinding; rank: number; share: number | null };

function Select<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
    >
      {label}
      <select
        id={id}
        value={String(value)}
        onChange={(event) => {
          const next = options.find(
            (option) => String(option.value) === event.target.value,
          );
          if (next !== undefined) onChange(next.value);
        }}
        className={`${inputBase} w-auto py-1`}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Card({
  item,
  names,
  at,
}: {
  item: Ranked;
  names: Readonly<Record<string, string>>;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const format = useFormatter();
  const { finding, rank, share } = item;
  const who =
    finding.level === "operator"
      ? (names[finding.subject] ?? finding.subject)
      : finding.subject;
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  return (
    <li
      data-finding={finding.id}
      data-confidence={finding.confidence}
      data-level={finding.level}
      className={`${panel} grid gap-4 p-4 md:grid-cols-[2rem_minmax(0,1fr)_220px]`}
    >
      <span className={`${mono} text-[12px] text-muted-foreground`}>
        {formatCount(rank, locale)}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold">
            {t(`findings.kind.${finding.kind}`)}
          </h3>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t(`findings.level.${finding.level}`)}
          </span>
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${finding.confidence === "high" ? "border-success/45 text-success" : "border-link/45 text-link"}`}
          >
            {t(`findings.confidence.${finding.confidence}`)}
          </span>
        </div>
        <p
          className={`text-[12.5px] ${finding.level === "operator" ? "" : mono}`}
        >
          {who}
        </p>
        <p className="text-[13px]">{finding.why}</p>
        <p className={`${mono} text-[11px] text-muted-foreground`}>
          {t("findings.evidenceLine", {
            runs: formatCount(finding.runs, locale),
            calls: formatCount(finding.calls, locale),
            from: day(finding.window.from),
            to: day(finding.window.to),
          })}
        </p>
      </div>
      <div className="flex flex-col items-start gap-1.5 md:items-end">
        <span className="text-2xl font-bold tabular-nums">
          <Money value={finding.saving} />
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {share === null
            ? t("findings.atStakeUnknown")
            : t("findings.atStake", { share: formatRatio(share, locale) })}
        </span>
        <span
          aria-hidden="true"
          className="block h-1 w-full overflow-hidden rounded-full bg-muted md:w-48"
        >
          <span
            className="block h-full bg-link"
            style={{ width: ratioWidth(share ?? 0) }}
          />
        </span>
        <span className="flex flex-wrap gap-2 pt-1">
          <SafeLink
            to={routes.spend(at.org, at.ws, {
              tab: "findings",
              finding: finding.id,
            })}
            className={buttonSecondary}
          >
            {t("findings.evidence.open")}
          </SafeLink>
          <FixDialog
            at={at}
            findingId={finding.id}
            fix={finding.fix}
            contextDescription={t("findings.fix.draft", {
              id: finding.id,
              subject: finding.subject,
              from: finding.window.from,
              to: finding.window.to,
              amount: formatMoney(finding.saving, {
                locale,
                precision: "exact",
              }),
              currency: finding.saving.currency,
              basis:
                finding.saving.basis === null
                  ? t("basisNotRecorded")
                  : t(`basis.${finding.saving.basis}`),
              runs: formatCount(finding.runs, locale),
              calls: formatCount(finding.calls, locale),
              fix: finding.fix,
              why: finding.why,
            })}
          />
        </span>
      </div>
    </li>
  );
}

export function FindingsList({
  findings,
  shares,
  names,
  at,
}: {
  findings: readonly SpendFinding[];
  shares: readonly (number | null)[];
  /** An operator finding's subject is a `prn_…` id; this is the person's name for it. */
  names: Readonly<Record<string, string>>;
  at: SpendAt;
}) {
  const t = useTranslations("spend.findings");
  const locale = useLocale();
  const [level, setLevel] = useState<Level>("all");
  const [confidence, setConfidence] = useState<Confidence>("all");
  const [sort, setSort] = useState<Sort>("rank");
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);

  const ranked: Ranked[] = findings.map((finding, index) => ({
    finding,
    rank: index + 1,
    share: shares[index] ?? null,
  }));
  const kindOf = (item: Ranked) => t(`kind.${item.finding.kind}`);
  const shown = ranked
    .filter(
      (item) =>
        (level === "all" || item.finding.level === level) &&
        (confidence === "all" || item.finding.confidence === confidence),
    )
    .sort((a, b) => {
      switch (sort) {
        case "rank":
          return a.rank - b.rank;
        case "savingDesc":
          return byMicrosDescending(a.finding.saving, b.finding.saving);
        case "savingAsc":
          return byMicrosDescending(b.finding.saving, a.finding.saving);
        case "kind":
          return kindOf(a).localeCompare(kindOf(b), locale);
      }
    });
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const current = Math.min(page, pages - 1);
  const slice = shown.slice(current * size, current * size + size);
  const reset =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(0);
    };

  return (
    <section aria-label={t("list")} className="flex flex-col gap-3">
      <div
        role="group"
        aria-label={t("filters.label")}
        className={`${panel} flex flex-wrap items-center gap-3 px-3 py-2.5`}
      >
        <Select<Level>
          id="spend-findings-level"
          label={t("filters.level")}
          value={level}
          options={LEVELS.map((value) => ({
            value,
            label: value === "all" ? t("filters.all") : t(`level.${value}`),
          }))}
          onChange={reset(setLevel)}
        />
        <Select<Confidence>
          id="spend-findings-confidence"
          label={t("filters.confidence")}
          value={confidence}
          options={CONFIDENCES.map((value) => ({
            value,
            label:
              value === "all" ? t("filters.all") : t(`confidence.${value}`),
          }))}
          onChange={reset(setConfidence)}
        />
        <Select<Sort>
          id="spend-findings-sort"
          label={t("filters.sort")}
          value={sort}
          options={SORTS.map((value) => ({
            value,
            label: t(`filters.sorts.${value}`),
          }))}
          onChange={reset(setSort)}
        />
        <Select<number>
          id="spend-findings-rows"
          label={t("filters.rows")}
          value={size}
          options={PAGE_SIZES.map((value) => ({
            value,
            label: formatCount(value, locale),
          }))}
          onChange={reset(setSize)}
        />
      </div>
      {slice.length === 0 ? (
        <p className={`${panel} p-4 text-[13px] text-muted-foreground`}>
          {t("filters.none")}
        </p>
      ) : (
        <ol aria-label={t("list")} className="flex flex-col gap-2.5">
          {slice.map((item) => (
            <Card key={item.finding.id} item={item} names={names} at={at} />
          ))}
        </ol>
      )}
      <nav
        aria-label={t("pager.label")}
        className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground"
      >
        <span className={mono}>
          {t("pager.range", {
            from: formatCount(
              shown.length === 0 ? 0 : current * size + 1,
              locale,
            ),
            to: formatCount(current * size + slice.length, locale),
            total: formatCount(shown.length, locale),
          })}
        </span>
        <span className="flex gap-1.5">
          <button
            type="button"
            data-touch-target=""
            className={buttonSecondary}
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            {t("pager.previous")}
          </button>
          <button
            type="button"
            data-touch-target=""
            className={buttonSecondary}
            disabled={current >= pages - 1}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            {t("pager.next")}
          </button>
        </span>
      </nav>
    </section>
  );
}
