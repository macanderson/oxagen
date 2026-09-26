"use client";
// The Runs panel's list controls (fleet.md): the search box, the Status, Tier
// and Replay facets, the pull-request filter, the column picker and the rows
// per page. The search and the facets change the URL's list query, and the
// server read applies them across the workspace (#3837). No control here
// filters the rows one page returned.
//
// The facet options are the closed vocabularies the read filters on
// (`list-query.ts`), so a facet can pick a tier no run on this page carries.
// The search sends what was typed once typing pauses, or at once on Enter.
import { Columns3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useId, useRef, useState } from "react";
import type { PullRequestFilter } from "@/data/contracts/runs";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import {
  type FleetListQuery,
  REPLAY_FACET,
  STATUS_FACET,
  TIER_FACET,
  withList,
} from "./list-query";
import { PAGE_SIZES, type PageSize, pageSizeOf } from "./prefs";

/**
 * How long typing must pause before the search is sent. Exported for its
 * test.
 *
 * @internal
 */
export const SEARCH_PAUSE_MS = 400;

const PR_FILTERS: readonly PullRequestFilter[] = ["any", "with", "without"];

const selectBase =
  "rounded-lg border border-input-border bg-input-bg px-2 py-[5px] text-xs text-input-fg max-md:min-h-11 max-md:text-base focus-visible:outline-2 focus-visible:outline-input-ring";

type Facet = "status" | "tier" | "replay";

/**
 * One facet as a select. The URL can carry several words for a facet, which
 * one select cannot show one by one, so that choice is drawn as one extra
 * option naming every word it holds.
 */
function FacetSelect<T extends string>({
  facet,
  label,
  chosen,
  options,
  wordOf,
  onChange,
}: {
  facet: Facet;
  label: string;
  chosen: readonly T[];
  options: readonly T[];
  wordOf: (value: T) => string;
  onChange: (next: T[]) => void;
}) {
  const t = useTranslations("fleet.runs");
  const combined = chosen.length > 1 ? chosen.join(",") : null;
  return (
    <select
      aria-label={t("facetLabel", { facet: label })}
      data-testid={`facet-${facet}`}
      value={combined ?? chosen[0] ?? ""}
      onChange={(event) => {
        const value = event.target.value;
        const picked = options.find((option) => option === value);
        onChange(picked === undefined ? [] : [picked]);
      }}
      className={selectBase}
    >
      <option value="">{t("facetAll", { facet: label })}</option>
      {combined === null ? null : (
        <option value={combined}>{chosen.map(wordOf).join(", ")}</option>
      )}
      {options.map((value) => (
        <option key={value} value={value}>
          {wordOf(value)}
        </option>
      ))}
    </select>
  );
}

/**
 * The search box. It holds what is being typed, sends it once typing pauses
 * or on Enter, and takes the URL's search back only when the URL changed to
 * something this box did not send (the back button).
 */
function SearchBox({
  value,
  onSearch,
}: {
  value: string;
  onSearch: (q: string) => void;
}) {
  const t = useTranslations("fleet.runs");
  const [draft, setDraft] = useState(value);
  // The last search this box sent, or took from the URL.
  const [sent, setSent] = useState(value);
  // The URL's search as this box last saw it.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== sent) {
      setSent(value);
      setDraft(value);
    }
  }
  const latestRef = useRef(onSearch);
  useEffect(() => {
    latestRef.current = onSearch;
  });

  useEffect(() => {
    const q = draft.trim();
    if (q === sent) return;
    const timer = setTimeout(() => {
      setSent(q);
      latestRef.current(q);
    }, SEARCH_PAUSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, sent]);

  return (
    <form
      role="search"
      aria-label={t("searchRuns")}
      className="flex min-w-36 flex-[1_1_200px]"
      onSubmit={(event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        const q = draft.trim();
        if (q === sent) return;
        setSent(q);
        onSearch(q);
      }}
    >
      <input
        type="search"
        value={draft}
        maxLength={200}
        placeholder={t("searchRuns")}
        aria-label={t("searchRuns")}
        data-testid="runs-search"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        className={`${inputBase} w-full py-1.5 max-md:min-h-11 max-md:text-base`}
      />
    </form>
  );
}

export function RunsListBar({
  list,
  onList,
  pageSize,
  onPageSize,
  pullRequests,
  onPullRequests,
  onColumns,
}: {
  list: FleetListQuery;
  /** Read the list again with this query: a navigation to its URL. */
  onList: (next: FleetListQuery) => void;
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
  pullRequests: PullRequestFilter;
  onPullRequests: (filter: PullRequestFilter) => void;
  onColumns: () => void;
}) {
  const t = useTranslations("fleet.runs");
  const status = useTranslations("ui.runStatus");
  const grade = useTranslations("ui.replayGrade");
  const rowsId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-[9px]">
      <SearchBox
        value={list.q}
        onSearch={(q) => {
          onList(withList(list, { q }));
        }}
      />
      <FacetSelect
        facet="tier"
        label={t("columns.tier")}
        chosen={list.tier}
        options={TIER_FACET}
        wordOf={(word) => word}
        onChange={(tier) => {
          onList(withList(list, { tier }));
        }}
      />
      <FacetSelect
        facet="replay"
        label={t("columns.replay")}
        chosen={list.replay}
        options={REPLAY_FACET}
        wordOf={(word) =>
          word === "not_recorded" ? t("notRecorded") : grade(`${word}.label`)
        }
        onChange={(replay) => {
          onList(withList(list, { replay }));
        }}
      />
      <FacetSelect
        facet="status"
        label={t("columns.status")}
        chosen={list.status}
        options={STATUS_FACET}
        wordOf={(word) => status(word)}
        onChange={(next) => {
          onList(withList(list, { status: next }));
        }}
      />
      <select
        aria-label={t("prFilter.label")}
        data-testid="pr-filter"
        value={pullRequests}
        onChange={(event) => {
          const next = PR_FILTERS.find((f) => f === event.target.value);
          if (next !== undefined) onPullRequests(next);
        }}
        className={selectBase}
      >
        {PR_FILTERS.map((filter) => (
          <option key={filter} value={filter}>
            {t(`prFilter.${filter}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="columns-open"
        data-touch-target=""
        onClick={onColumns}
        className={`${buttonSecondary} inline-flex items-center gap-1.5 px-2.5 py-1 text-xs`}
      >
        <Columns3 aria-hidden className="size-3.5" />
        {t("columnsPicker.open")}
      </button>
      <label
        htmlFor={rowsId}
        className="ms-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground"
      >
        {t("rows")}
        <select
          id={rowsId}
          data-testid="rows-per-page"
          value={String(pageSize)}
          onChange={(event) => {
            onPageSize(pageSizeOf(event.target.value));
          }}
          className={selectBase}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={String(size)}>
              {String(size)}
            </option>
          ))}
        </select>
      </label>
      {pullRequests === "any" ? null : (
        <p
          data-testid="pr-filter-note"
          className="basis-full text-[11.5px] text-muted-foreground"
        >
          {t("prFilter.note")}
        </p>
      )}
    </div>
  );
}
