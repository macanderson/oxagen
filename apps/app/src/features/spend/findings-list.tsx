"use client";
// The ranked finding cards with the design's filters (spec "Findings"):
// Level, Confidence and Sort (Rank, Savings high first, Savings low first,
// Finding A to Z) above the cards, and under them the shared pager with Rows
// per page, the range, Previous and Next. Filtering runs over the open
// findings the server listed, largest saving first, so a finding's rank is its
// place in that list and never changes with a filter. Each card is the one
// the spend spec draws for its kind (./finding-card.tsx): its amount and its
// share of the workspace's spend first, then its finding text, what it cites,
// Evidence and Fix. A finding about an agent draws the agent's avatar with its
// registered harness (#4871). The server lists one page of at most 50
// findings, and the list filters, sorts and pages that page. A finding's rank
// counts from the page's first rank, so the second page starts at 51 (#5303).
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { byMicrosDescending, type Cost } from "@/data/contracts/money";
import type { SpendFinding } from "@/data/contracts/spend";
import { panel } from "@/ui/control-styles";
import { ListSelect } from "@/ui/list-select";
import { formatCount } from "@/ui/money-format";
import { RowsPager } from "@/ui/pagination";
import type { AgentHarnesses } from "./agent-mark";
import { FindingCard } from "./finding-card";
import type { SpendAt } from "./view";

const LEVELS = ["all", "agent", "operator", "tool", "workspace"] as const;
const CONFIDENCES = ["all", "high", "medium"] as const;
const SORTS = ["rank", "savingDesc", "savingAsc", "kind"] as const;
const PAGE_SIZES = [10, 25, 50] as const;

type Level = (typeof LEVELS)[number];
type Confidence = (typeof CONFIDENCES)[number];
type Sort = (typeof SORTS)[number];

type Ranked = { finding: SpendFinding; rank: number };

// A filter is the shared list select (`ui/list-select.tsx`).
function Filter<T extends string>({
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
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span id={`${id}-label`}>{label}</span>
      <ListSelect
        items={options}
        value={value}
        onValue={(next) => {
          const picked = options.find((option) => option.value === next);
          if (picked !== undefined) onChange(picked.value);
        }}
        id={id}
        aria-labelledby={`${id}-label`}
        size="sm"
        className="text-sm max-md:min-h-11 max-md:text-base"
      />
    </span>
  );
}

export function FindingsList({
  findings,
  firstRank = 1,
  cursor = null,
  spend,
  names,
  harnesses = {},
  at,
}: {
  findings: readonly SpendFinding[];
  /** The rank of the first finding listed: 1 on the first page, 51 on the second. */
  firstRank?: number;
  /** The cursor of the page listed; null on the first page. */
  cursor?: string | null;
  /** The workspace's priced spend over the findings' window, each card's share is of; null when none was recorded. */
  spend: Cost | null;
  /** An operator finding's subject is a `prn_…` id; this is the person's name for it. */
  names: Readonly<Record<string, string>>;
  /** An agent finding's subject is an agent key; this is its harness by key. */
  harnesses?: AgentHarnesses;
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
    rank: firstRank + index,
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
        <Filter<Level>
          id="spend-findings-level"
          label={t("filters.level")}
          value={level}
          options={LEVELS.map((value) => ({
            value,
            label: value === "all" ? t("filters.all") : t(`level.${value}`),
          }))}
          onChange={reset(setLevel)}
        />
        <Filter<Confidence>
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
        <Filter<Sort>
          id="spend-findings-sort"
          label={t("filters.sort")}
          value={sort}
          options={SORTS.map((value) => ({
            value,
            label: t(`filters.sorts.${value}`),
          }))}
          onChange={reset(setSort)}
        />
      </div>
      {slice.length === 0 ? (
        <p className={`${panel} p-4 text-sm text-muted-foreground`}>
          {t("filters.none")}
        </p>
      ) : (
        <ol aria-label={t("list")} className="flex flex-col gap-2.5">
          {slice.map((item) => (
            <FindingCard
              key={item.finding.id}
              finding={item.finding}
              rank={item.rank}
              cursor={cursor}
              names={names}
              harnesses={harnesses}
              spend={spend}
              at={at}
            />
          ))}
        </ol>
      )}
      {/* The cards sit in no panel, so the pager drops its side padding and
          lines up with their edges. Changing the rows goes back to page 1. */}
      <RowsPager
        label={t("pager.label")}
        rowsLabel={t("filters.rows")}
        perPage={size}
        sizes={PAGE_SIZES}
        onPerPage={reset(setSize)}
        sizeLabel={(value) => formatCount(value, locale)}
        range={t("pager.range", {
          from: formatCount(
            shown.length === 0 ? 0 : current * size + 1,
            locale,
          ),
          to: formatCount(current * size + slice.length, locale),
          total: formatCount(shown.length, locale),
        })}
        previousLabel={t("pager.previous")}
        nextLabel={t("pager.next")}
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
        className="px-0"
      />
    </section>
  );
}
