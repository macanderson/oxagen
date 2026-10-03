"use client";
// The Runs panel's list controls (fleet.md): the search box, the Status, Tier
// and Replay facets, the pull-request filter and the column picker. The rows
// per page sit in the pager under the table. The search and the facets change the URL's list query, and the
// server read applies them across the workspace (#3837). No control here
// filters the rows one page returned.
//
// The facet options are the closed vocabularies the read filters on
// (`list-query.ts`), so a facet can pick a tier no run on this page carries.
// The search sends what was typed once typing pauses, or at once on Enter.
// Each select is the app's Select, so its list opens on the translucent menu
// surface.
import { ColumnsIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { PullRequestFilter } from "@/data/contracts/runs";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { ListSelect, type ListSelectItem } from "@/ui/list-select";
import {
  type FleetListQuery,
  REPLAY_FACET,
  STATUS_FACET,
  TIER_FACET,
  withList,
} from "./list-query";

/**
 * How long typing must pause before the search is sent. Exported for its
 * test.
 *
 * @internal
 */
export const SEARCH_PAUSE_MS = 400;

const PR_FILTERS: readonly PullRequestFilter[] = ["any", "with", "without"];

const triggerSize = "text-sm max-md:min-h-11 max-md:text-input-touch";

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
  const items: ListSelectItem[] = [
    { value: "", label: t("facetAll", { facet: label }) },
    ...(combined === null
      ? []
      : [{ value: combined, label: chosen.map(wordOf).join(", ") }]),
    ...options.map((value) => ({ value, label: wordOf(value) })),
  ];
  return (
    <ListSelect
      items={items}
      value={combined ?? chosen[0] ?? ""}
      size="sm"
      aria-label={t("facetLabel", { facet: label })}
      data-testid={`facet-${facet}`}
      className={triggerSize}
      onValue={(value) => {
        const picked = options.find((option) => option === value);
        onChange(picked === undefined ? [] : [picked]);
      }}
    />
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
      className="flex min-w-36 grow basis-50"
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
        className={`${inputBase} w-full py-1.5 max-md:min-h-11 max-md:text-input-touch`}
      />
    </form>
  );
}

export function RunsListBar({
  list,
  onList,
  pullRequests,
  onPullRequests,
  onColumns,
}: {
  list: FleetListQuery;
  /** Read the list again with this query: a navigation to its URL. */
  onList: (next: FleetListQuery) => void;
  pullRequests: PullRequestFilter;
  onPullRequests: (filter: PullRequestFilter) => void;
  onColumns: () => void;
}) {
  const t = useTranslations("fleet.runs");
  const status = useTranslations("ui.runStatus");
  const grade = useTranslations("ui.replayGrade");
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.25">
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
      <ListSelect
        items={PR_FILTERS.map((filter) => ({
          value: filter,
          label: t(`prFilter.${filter}`),
        }))}
        value={pullRequests}
        size="sm"
        aria-label={t("prFilter.label")}
        data-testid="pr-filter"
        className={triggerSize}
        onValue={(value) => {
          const next = PR_FILTERS.find((f) => f === value);
          if (next !== undefined) onPullRequests(next);
        }}
      />
      <button
        type="button"
        data-testid="columns-open"
        data-touch-target=""
        onClick={onColumns}
        className={`${buttonSecondary} inline-flex items-center gap-1.5 px-2.5 py-1 text-sm`}
      >
        <ColumnsIcon aria-hidden className="size-3.5" />
        {t("columnsPicker.open")}
      </button>
      {pullRequests === "any" ? null : (
        <p
          data-testid="pr-filter-note"
          className="basis-full text-xs text-muted-foreground"
        >
          {t("prFilter.note")}
        </p>
      )}
    </div>
  );
}
