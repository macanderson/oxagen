"use client";
// Fleet's tiles and Runs panel (fleet.md): four summary tiles and the list of
// runs with its filter chips, list controls and per-row action.
//
// One client component holds both, because the filter chips change what the
// tiles add up: Spend shown and Tokens shown are sums over the rows listed,
// and the labels say "shown" for that reason. Every figure here comes from
// `view.ts` over the same rows the table draws.
//
// The page size is the read's own limit, and the pull-request filter is the
// read's own filter, so both change what `list_runs` returns rather than
// slicing a fixed page. The page size and the columns shown are the person's
// saved choice (`prefs.ts`), kept in a cookie the page reads on the server.
// Search, facets and sort run over the rows the read returned. The pager says
// so: its total carries a `+` when the read stopped before the oldest run, and
// a link opens the next read.
import { ArrowUpDown, Columns3 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useId,
  useMemo,
  useState,
  useTransition,
} from "react";
import type { ApprovalQueue } from "@/data/contracts/approvals";
import {
  type CommandBlock,
  commandBlockOf,
  type PullRequestFilter,
  type RunRow,
} from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { openApprovals } from "@/features/shell/client";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import {
  COMMAND_BLOCK_COPY,
  UNANSWERED,
  useActionFailure,
} from "@/ui/command-failure";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  linkText,
  mono,
  panel,
  panelHeader,
  panelTitle,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { SheetDialog } from "@/ui/sheet-dialog";
import { StatusBadge } from "@/ui/status-badge";
import { cell, headCell, numericCell } from "@/ui/table";
import { ToastStack, useToasts } from "@/ui/toast";
import { dispatchRunCommand, exportFleetRun } from "./actions";
import { DiffCell, PullRequestsCell, SummaryCell } from "./run-cells";
import { Clock } from "@/ui/clock";
import {
  DEFAULT_FLEET_PREFS,
  FIXED_COLUMN,
  FLEET_COLUMNS,
  type FleetColumn,
  type FleetPrefs,
  fleetPrefsCookieString,
  PAGE_SIZES,
  type PageSize,
  pageSizeOf,
  shownColumns,
  withColumn,
} from "./prefs";
import {
  applyList,
  chipRows,
  type Facets,
  facetValues,
  type ListedRun,
  type ListQuery,
  listRuns,
  liveCount,
  oldestApproval,
  parkedRunIds,
  pullRequestLabel,
  RUN_CHIPS,
  type RowWords,
  type RunChip,
  type SortKey,
  shownCost,
  spendShown,
  windowParts,
} from "./view";

/** An agent the steer dialog can address. */
export type FleetAgent = { agentKey: string };

type Place = { org: string; ws: string };

// ── Tiles ────────────────────────────────────────────────────────────────

function Tile({
  term,
  value,
  note,
  valueClass = "",
}: {
  term: string;
  value: ReactNode;
  note: ReactNode;
  valueClass?: string;
}) {
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={`${statValue} ${valueClass}`}>{value}</dd>
      <dd className={statNote}>{note}</dd>
    </dl>
  );
}

function WaitingTile({
  approvals,
  now,
}: {
  approvals: Read<ApprovalQueue>;
  now: number;
}) {
  const t = useTranslations("fleet.stats.waiting");
  const locale = useLocale();
  const drawer = t("drawer");
  // The design counts an open interjection in this tile. No store records
  // one yet (#3839), so the tile counts approvals and says interjections are
  // missing rather than letting the count read as the whole of what waits.
  const interjections = (
    <span data-recorded="false" data-testid="interjections-not-recorded">
      {t("interjections")}
    </span>
  );
  let value: ReactNode;
  let note: ReactNode;
  if (!approvals.ok) {
    value = <span className="text-muted-foreground">—</span>;
    note = (
      <>
        {t("unread", {
          code:
            approvals.reason === "denied"
              ? approvals.permission
              : approvals.reason === "error"
                ? approvals.code
                : approvals.accessRequestId,
        })}
        {" · "}
        {interjections}
      </>
    );
  } else {
    const { items, more } = approvals.value;
    const count = formatCount(items.length, locale);
    value = more ? t("more", { count }) : count;
    const oldest = oldestApproval(items);
    const limit = oldest === null ? null : windowParts(oldest.windowSeconds);
    note = (
      <>
        {oldest === null || limit === null
          ? t("none")
          : t.rich("oldest", {
              clock: () => (
                <Clock at={oldest.createdAt} now={now} direction="since" />
              ),
              window:
                limit.seconds === 0
                  ? t("window", { minutes: limit.minutes })
                  : t("windowSeconds", limit),
            })}
        {more ? ` · ${t("moreBasis")}` : null}
        {" · "}
        {interjections}
        {` · ${drawer}`}
      </>
    );
  }
  return (
    <button
      type="button"
      data-testid="tile"
      aria-label={t("open")}
      onClick={openApprovals}
      className={`${statTile} cursor-pointer text-left transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      <span className={statTerm}>{t("title")}</span>
      <span className={`${statValue} text-info`}>{value}</span>
      <span className={statNote}>{note}</span>
    </button>
  );
}

function Tiles({
  listed,
  approvals,
  agentTotal,
  now,
}: {
  listed: readonly ListedRun[];
  approvals: Read<ApprovalQueue>;
  agentTotal: number | null;
  now: number;
}) {
  const t = useTranslations("fleet.stats");
  const locale = useLocale();
  const spend = spendShown(listed);
  const basisWords = [
    ...spend.bases,
    ...(spend.unbased > 0 ? [t("spend.unbased")] : []),
  ];
  const spendNote = [
    basisWords.length === 0 ? t("spend.noBasis") : basisWords.join(" + "),
    ...(spend.total === null ? [] : [spend.total.currency]),
    ...(spend.estimated > 0
      ? [t("spend.estimated", { count: spend.estimated })]
      : []),
    ...(spend.unpriced > 0
      ? [t("spend.unpriced", { count: spend.unpriced })]
      : []),
  ].join(" · ");
  return (
    <section aria-label={t("label")} className={`${statStrip} mb-4`}>
      <Tile
        term={t("live.title")}
        value={formatCount(liveCount(listed), locale)}
        note={
          agentTotal === null
            ? t("live.basisUnread")
            : t("live.basis", { count: agentTotal })
        }
      />
      <WaitingTile approvals={approvals} now={now} />
      <Tile
        term={t("spend.title")}
        value={
          spend.total !== null ? (
            <Money value={spend.total} />
          ) : (
            <span className="text-base font-medium text-muted-foreground">
              {spend.mixedCurrency ? t("spend.mixed") : t("spend.notRecorded")}
            </span>
          )
        }
        note={<span data-testid="spend-basis">{spendNote}</span>}
      />
      {/* list_runs carries no token figures yet, so there is no sum to take:
          the tile says so rather than printing a zero (fleet.md, G3; #3834). */}
      <Tile
        term={t("tokens.title")}
        value={
          <span
            data-testid="tokens-not-recorded"
            data-recorded="false"
            data-gap="G3"
            className="text-base font-medium text-muted-foreground"
          >
            {t("tokens.notRecorded")}
          </span>
        }
        note={
          <span data-recorded="false" data-gap="G3">
            {t("tokens.noCache")}
          </span>
        }
      />
    </section>
  );
}

// ── Row words and cells ──────────────────────────────────────────────────

// A run's second line: its name (the harness title, else the generated one),
// else its task reference, the same fallback the Run page's header reads.
// Turning enrichment off stops Oxagen generating names; it never hides the
// title the harness recorded. A run with neither shows only its id.
function runTitle(run: RunRow): string | null {
  return run.name ?? run.taskRef;
}

function useRowWords(listed: readonly ListedRun[]): RowWords[] {
  const t = useTranslations("fleet.runs");
  const status = useTranslations("ui.runStatus");
  const grade = useTranslations("ui.replayGrade");
  return useMemo(
    () =>
      listed.map(({ run, state }) => {
        // The design's lifecycle word (live, sealed, halted, parked for
        // approval), which the Status facet lists too. The outcome stays on
        // the badge's hover text.
        const statusWord =
          state === "parked" ? t("parked") : status(run.status);
        const operator =
          run.operatorName ??
          (run.operatorKind === null
            ? (run.operatorId ?? t("notRecorded"))
            : t(`operatorKind.${run.operatorKind}`));
        const words = {
          run: run.id,
          agent: run.agentKey ?? t("notRecorded"),
          operator,
          status: statusWord,
          tier: run.enforcementTier,
          replay:
            run.replayGrade === null
              ? t("notRecorded")
              : grade(`${run.replayGrade}.label`),
        };
        const text = [
          ...Object.values(words),
          runTitle(run) ?? "",
          run.enrichmentEnabled === false ? "" : (run.summary?.text ?? ""),
          ...(run.pullRequests ?? []).map(
            (pull) => pullRequestLabel(pull) ?? "",
          ),
          run.harness?.name ?? "",
          run.cost?.basis ?? "",
        ].join(" ");
        return { ...words, text };
      }),
    [listed, t, status, grade],
  );
}

/**
 * The design's tier pill (`tierBadge`): the recorded tier word in the mono
 * face, with what the tier means on hover. The hue follows the ladder the
 * design draws and never reaches the gold; the word is the record's, so
 * nothing here reads stronger than what the run earned.
 */
const TIER_TONE = {
  observe: "quiet",
  harness: "approval",
  gateway: "allowed",
  contained: "proven",
} as const;

function TierBadge({ tier }: { tier: RunRow["enforcementTier"] }) {
  const t = useTranslations("ui.enforcementTier");
  return (
    <span title={t(tier)}>
      <Badge tone={TIER_TONE[tier]} dot={false} mono data-tier={tier}>
        {tier}
      </Badge>
    </span>
  );
}

function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

function Started({ at, now }: { at: string; now: number }) {
  const format = useFormatter();
  const date = new Date(at);
  const sameDay =
    format.dateTime(date, { dateStyle: "short" }) ===
    format.dateTime(new Date(now), { dateStyle: "short" });
  return (
    <time dateTime={at}>
      {sameDay
        ? format.dateTime(date, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          })
        : format.dateTime(date, { dateStyle: "medium", timeStyle: "medium" })}
    </time>
  );
}

// ── The Runs panel ───────────────────────────────────────────────────────

/**
 * How each column heads the table. `sort` names what a header click sorts
 * on. `tokens` has no figure to sort yet, and `summary` is prose with no
 * order a reader would use, so neither sorts.
 */
const COLUMN_HEAD: Record<
  FleetColumn,
  { sort: SortKey | "tokens" | null; numeric?: boolean }
> = {
  run: { sort: "run" },
  summary: { sort: null },
  agent: { sort: "agent" },
  operator: { sort: "operator" },
  status: { sort: "status" },
  pullRequests: { sort: "pullRequests" },
  diff: { sort: "diff", numeric: true },
  tier: { sort: "tier" },
  replay: { sort: "replay" },
  tokens: { sort: "tokens", numeric: true },
  cost: { sort: "cost", numeric: true },
  frames: { sort: "frames", numeric: true },
  started: { sort: "started" },
};

const FACETS = ["tier", "replay", "status"] as const;

const PR_FILTERS: readonly PullRequestFilter[] = ["any", "with", "without"];

const selectBase =
  "rounded-lg border border-input-border bg-input-bg px-2 py-[5px] text-xs text-input-fg max-md:min-h-11 max-md:text-base focus-visible:outline-2 focus-visible:outline-input-ring";

function Chips({
  chip,
  onChip,
}: {
  chip: RunChip;
  onChip: (chip: RunChip) => void;
}) {
  const t = useTranslations("fleet.runs");
  return (
    <div role="group" aria-label={t("chipsLabel")} className="flex gap-1.5">
      {RUN_CHIPS.map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={chip === name}
          data-testid={`chip-${name}`}
          data-touch-target=""
          onClick={() => {
            onChip(name);
          }}
          className={`${buttonSecondary} px-2.5 py-1 text-xs ${chip === name ? "border-rule bg-hl font-semibold text-foreground" : ""}`}
        >
          {t(`chips.${name}`)}
        </button>
      ))}
    </div>
  );
}

function ListBar({
  query,
  setQuery,
  words,
  pageSize,
  onPageSize,
  pullRequests,
  onPullRequests,
  onColumns,
}: {
  query: ListQuery;
  setQuery: (next: ListQuery) => void;
  words: readonly RowWords[];
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
  pullRequests: PullRequestFilter;
  onPullRequests: (filter: PullRequestFilter) => void;
  onColumns: () => void;
}) {
  const t = useTranslations("fleet.runs");
  const rowsId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-[9px]">
      <input
        type="search"
        value={query.search}
        placeholder={t("search")}
        aria-label={t("search")}
        onChange={(event) => {
          setQuery({ ...query, search: event.target.value, page: 1 });
        }}
        className={`${inputBase} min-w-36 flex-[1_1_200px] py-1.5 max-md:min-h-11 max-md:text-base`}
      />
      {FACETS.map((facet) => {
        const label = t(`columns.${facet}`);
        return (
          <select
            key={facet}
            aria-label={t("facetLabel", { facet: label })}
            data-testid={`facet-${facet}`}
            value={query.facets[facet] ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              const facets: Facets = {
                ...query.facets,
                [facet]: value === "" ? null : value,
              };
              setQuery({ ...query, facets, page: 1 });
            }}
            className={selectBase}
          >
            <option value="">{t("facetAll", { facet: label })}</option>
            {facetValues(words, facet).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        );
      })}
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

/**
 * Which columns the table shows. Each change applies at once and is saved in
 * this browser's cookie, so the next visit draws the same table. The run
 * column names the row, so it stays.
 */
function ColumnPicker({
  open,
  onOpenChange,
  prefs,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: FleetPrefs;
  onChange: (next: FleetPrefs) => void;
}) {
  const t = useTranslations("fleet.runs");
  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("columnsPicker.title")}
      subtitle={t("columnsPicker.subtitle")}
      testId="columns-dialog"
      footerNote={t("columnsPicker.saved")}
      footer={
        <button
          type="button"
          data-testid="columns-reset"
          data-touch-target=""
          disabled={prefs.hidden.size === 0}
          onClick={() => {
            onChange({ ...prefs, hidden: new Set() });
          }}
          className={buttonSecondary}
        >
          {t("columnsPicker.reset")}
        </button>
      }
    >
      <fieldset className="flex flex-col gap-0.5">
        <legend className="sr-only">{t("columnsPicker.legend")}</legend>
        {FLEET_COLUMNS.map((column) => {
          const fixed = column === FIXED_COLUMN;
          return (
            <label
              key={column}
              data-touch-target=""
              className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] hover:bg-hl max-md:min-h-11"
            >
              <input
                type="checkbox"
                data-testid={`column-${column}`}
                checked={!prefs.hidden.has(column)}
                disabled={fixed}
                onChange={(event) => {
                  onChange(withColumn(prefs, column, event.target.checked));
                }}
                className="size-4"
              />
              <span>{t(`columns.${column}`)}</span>
              {fixed ? (
                <span className="text-xs text-muted-foreground">
                  {t("columnsPicker.fixed")}
                </span>
              ) : null}
            </label>
          );
        })}
      </fieldset>
    </SheetDialog>
  );
}

function Pager({
  from,
  to,
  total,
  more,
  org,
  ws,
  cursor,
  nextCursor,
  pullRequests,
}: {
  from: number;
  to: number;
  total: number;
  /** True when the read stopped before the oldest run. */
  more: boolean;
  cursor: string | null;
  nextCursor: string | null;
  pullRequests: PullRequestFilter;
} & Place) {
  const t = useTranslations("fleet.runs.pager");
  const locale = useLocale();
  const range =
    total === 0
      ? t("none")
      : t(more ? "rangeMore" : "range", {
          from: formatCount(from, locale),
          to: formatCount(to, locale),
          total: formatCount(total, locale),
        });
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground"
    >
      <span data-testid="pager-range" className="font-mono tabular-nums">
        {range}
      </span>
      <span className="ms-auto flex flex-wrap items-center gap-3">
        {cursor === null ? null : (
          <SafeLink
            to={routes.fleet(org, ws, { prs: pullRequests })}
            data-touch-target=""
            className={`${linkText} inline-flex items-center`}
          >
            {t("newest")}
          </SafeLink>
        )}
        {nextCursor === null ? null : (
          <SafeLink
            to={routes.fleet(org, ws, {
              cursor: nextCursor,
              prs: pullRequests,
            })}
            data-touch-target=""
            className={`${linkText} inline-flex items-center`}
          >
            {t("older")}
          </SafeLink>
        )}
      </span>
    </nav>
  );
}

function RunRowView({
  listed,
  columns,
  now,
  org,
  ws,
  exporting,
  onPause,
  onExport,
}: {
  listed: ListedRun;
  columns: readonly FleetColumn[];
  now: number;
  exporting: boolean;
  onPause: (run: RunRow) => void;
  onExport: (run: RunRow) => void;
} & Place) {
  const t = useTranslations("fleet.runs");
  const locale = useLocale();
  const navigate = useNavigate();
  const { run, state } = listed;
  const to = routes.run(org, ws, run.id);
  const title = runTitle(run);
  const cost = shownCost(run);
  const operatorLabel =
    run.operatorName ??
    (run.operatorKind === null
      ? run.operatorId
      : t(`operatorKind.${run.operatorKind}`));
  const notRecorded = (
    <span className="text-muted-foreground">{t("notRecorded")}</span>
  );
  const action =
    state === "live" ? "pause" : state === "parked" ? "resolve" : "export";

  function cellOf(column: FleetColumn): ReactNode {
    switch (column) {
      case "run":
        return (
          <td key={column} className={`${cell} min-w-48 max-w-72`}>
            <SafeLink
              to={to}
              onClick={(event) => {
                event.stopPropagation();
              }}
              data-touch-target=""
              className={`${mono} block truncate text-[12px] text-muted-foreground hover:text-foreground max-md:leading-[44px]`}
            >
              {run.id}
            </SafeLink>
            {title === null ? null : (
              <span className="block text-[11.5px] text-dim" title={title}>
                {title}
              </span>
            )}
          </td>
        );
      case "summary":
        return (
          <td key={column} className={`${cell} min-w-56 max-w-80`}>
            <SummaryCell run={run} />
          </td>
        );
      case "agent":
        return (
          <td key={column} className={`${cell} min-w-48`}>
            <AgentCard
              agentKey={run.agentKey}
              notRecorded={t("notRecorded")}
              sub={
                run.harness
                  ? `${run.harness.name}${run.harness.version ? ` ${run.harness.version}` : ""}`
                  : t(`source.${run.source}`)
              }
            />
          </td>
        );
      case "operator":
        return (
          <td key={column} className={`${cell} whitespace-nowrap`}>
            {operatorLabel === null ? (
              notRecorded
            ) : (
              <span className="inline-flex items-center gap-[7px]">
                <Avatar
                  value={null}
                  initials={initialsOf(run.operatorName ?? operatorLabel)}
                  size={22}
                />
                <span
                  className={
                    run.operatorName === null && run.operatorKind === null
                      ? mono
                      : undefined
                  }
                >
                  {operatorLabel}
                </span>
              </span>
            )}
          </td>
        );
      case "status":
        return (
          <td key={column} className={cell}>
            {state === "parked" ? (
              <Badge tone="approval" data-status="parked">
                {t("parked")}
              </Badge>
            ) : (
              <StatusBadge
                status={run.status}
                outcome={run.outcome}
                vocabulary="lifecycle"
              />
            )}
          </td>
        );
      case "pullRequests":
        return (
          <td key={column} className={`${cell} text-[12px]`}>
            <PullRequestsCell run={run} />
          </td>
        );
      case "diff":
        return (
          <td key={column} className={numericCell}>
            <DiffCell diff={run.diff} />
          </td>
        );
      case "tier":
        return (
          <td key={column} className={cell}>
            <TierBadge tier={run.enforcementTier} />
          </td>
        );
      case "replay":
        return (
          <td key={column} className={cell}>
            {run.replayGrade === null ? (
              notRecorded
            ) : (
              <ReplayGradeBadge grade={run.replayGrade} />
            )}
          </td>
        );
      case "tokens":
        return (
          <td key={column} className={numericCell}>
            {/* Tokens are not on list_runs yet (G3, #3834); the cell says so. */}
            <span
              data-testid="row-tokens"
              data-recorded="false"
              data-gap="G3"
              className="text-muted-foreground"
            >
              {t("notRecorded")}
            </span>
          </td>
        );
      case "cost":
        return (
          <td key={column} className={numericCell}>
            {cost === null ? (
              notRecorded
            ) : (
              <>
                <Money value={cost.value} />
                <span className="block text-[10px] text-muted-foreground">
                  {cost.estimate ? (
                    // A running rollup, or before any rollup the agent's own
                    // figure, which Spend shown counts as an estimate too.
                    <span
                      data-testid={
                        cost.reported
                          ? "row-cost-reported"
                          : "row-cost-estimate"
                      }
                    >
                      {t("estimate")}
                    </span>
                  ) : (
                    (cost.value.basis ?? t("basisNotRecorded"))
                  )}
                </span>
              </>
            )}
          </td>
        );
      case "frames":
        return (
          <td key={column} className={numericCell}>
            {formatCount(run.frames, locale)}
          </td>
        );
      case "started":
        return (
          <td
            key={column}
            className={`${cell} whitespace-nowrap font-mono text-[11px] text-muted-foreground`}
          >
            <Started at={run.startedAt} now={now} />
          </td>
        );
    }
  }

  return (
    <tr
      data-testid="run-row"
      data-state={state}
      className="cursor-pointer"
      onClick={() => {
        navigate.push(to);
      }}
    >
      {columns.map(cellOf)}
      <td
        className={cell}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {action === "resolve" ? (
          <SafeLink
            to={to}
            data-testid="row-resolve"
            data-touch-target=""
            aria-label={t("rowAction", { action: t("resolve"), run: run.id })}
            className={`${buttonSecondary} px-2.5 py-1 text-xs`}
          >
            {t("resolve")}
          </SafeLink>
        ) : (
          <button
            type="button"
            data-testid={`row-${action}`}
            data-touch-target=""
            disabled={action === "export" && exporting}
            aria-label={t("rowAction", {
              action: t(action),
              run: run.id,
            })}
            onClick={() => {
              if (action === "pause") onPause(run);
              else onExport(run);
            }}
            className={`${buttonSecondary} px-2.5 py-1 text-xs`}
          >
            {t(action)}
          </button>
        )}
      </td>
    </tr>
  );
}

// ── Pause ────────────────────────────────────────────────────────────────

type PauseRefusal =
  | `blocked.${(typeof COMMAND_BLOCK_COPY)[CommandBlock]}`
  | "ledgerReason"
  | "roleReason";

/**
 * Why a live run cannot take a pause from Oxagen, or null when it can. The
 * enforcement tier plays no part (ADR-163): the row's `commandBlock` says
 * whether the run's host can collect a command.
 */
function pauseRefusal(run: RunRow, canCommand: boolean): PauseRefusal | null {
  if (run.source === "ledger") return "ledgerReason";
  const block = commandBlockOf(run);
  if (block !== null) return `blocked.${COMMAND_BLOCK_COPY[block]}`;
  if (!canCommand) return "roleReason";
  return null;
}

function PauseDialog({
  run,
  canCommand,
  onClose,
  onQueued,
  org,
  ws,
}: {
  run: RunRow | null;
  canCommand: boolean;
  onClose: () => void;
  onQueued: (run: RunRow) => void;
} & Place) {
  const t = useTranslations("fleet.pause");
  const command = useTranslations("run.commands");
  const failureText = useActionFailure();
  const formId = useId();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const refusal = run === null ? null : pauseRefusal(run, canCommand);

  function close() {
    setReason("");
    setFailure(null);
    onClose();
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (run === null || refusal !== null || pending) return;
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await dispatchRunCommand(
          org,
          ws,
          run.id,
          "pause",
          reason,
        );
        if (!result.ok) setFailure(failureText(result));
        else if (result.value.commandIds.length === 0)
          setFailure(command("noRecipient"));
        else {
          setReason("");
          onQueued(run);
        }
      } catch {
        setFailure(failureText(UNANSWERED));
      }
    });
  }

  return (
    <SheetDialog
      open={run !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("title")}
      closeLabel={t("cancel")}
      headerClose
      testId="pause-dialog"
      footerNote={t.rich("footer", {
        mono: (chunks) => <span className={mono}>{chunks}</span>,
      })}
      footer={
        <button
          type="submit"
          form={formId}
          data-touch-target=""
          disabled={refusal !== null || pending}
          className={buttonPrimary}
        >
          {pending ? t("pending") : t("confirm")}
        </button>
      }
    >
      {run === null ? null : (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-[12.5px] text-muted-foreground">{t("body")}</p>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px] text-[12.5px]">
            <dt className="text-dim">{t("run")}</dt>
            <dd className={mono}>{run.id}</dd>
            <dt className="text-dim">{t("position")}</dt>
            <dd>
              {run.turns === null
                ? t("positionNoTurn", { steps: run.steps, frames: run.frames })
                : t("positionValue", {
                    turn: run.turns,
                    steps: run.steps,
                    frames: run.frames,
                  })}
            </dd>
            <dt className="text-dim">{t("recordedAs")}</dt>
            <dd>
              {t.rich("recordedValue", {
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </dd>
          </dl>
          {refusal === null ? null : (
            <p
              data-testid="pause-refusal"
              className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground"
            >
              {command(refusal)}
            </p>
          )}
          <label htmlFor={fieldId} className="text-xs font-medium">
            {t("reason")}
          </label>
          <textarea
            id={fieldId}
            name="reason"
            rows={2}
            value={reason}
            disabled={refusal !== null}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className={`${inputBase} resize-y max-md:text-base`}
          />
          <p className="text-xs text-muted-foreground">{t("note")}</p>
          {failure === null ? null : (
            <FormAlert testId="pause-failure">{failure}</FormAlert>
          )}
        </form>
      )}
    </SheetDialog>
  );
}

// ── The board ────────────────────────────────────────────────────────────

export function FleetBoard({
  runs,
  nextCursor,
  cursor,
  approvals,
  agentTotal,
  now,
  canCommand,
  prefs: savedPrefs = DEFAULT_FLEET_PREFS,
  pullRequests = "any",
  pullRequestsUnread = false,
  org,
  ws,
}: {
  runs: RunRow[];
  nextCursor: string | null;
  cursor: string | null;
  approvals: Read<ApprovalQueue>;
  /** Identities in the workspace; null when the agents read failed. */
  agentTotal: number | null;
  /** Epoch milliseconds the reads returned at. */
  now: number;
  /** Whether `dispatch_command` admits this viewer. */
  canCommand: boolean;
  /** The columns and page size the person saved, read from the cookie by the page. */
  prefs?: FleetPrefs;
  /** The pull-request filter the read applied. */
  pullRequests?: PullRequestFilter;
  /** The read could not see this page's pull requests. */
  pullRequestsUnread?: boolean;
} & Place) {
  const t = useTranslations("fleet.runs");
  const pauseT = useTranslations("fleet.pause");
  const navigate = useNavigate();
  const failureText = useActionFailure();
  const [chip, setChip] = useState<RunChip>("all");
  const [query, setQuery] = useState<ListQuery>({
    search: "",
    facets: { tier: null, replay: null, status: null },
    sort: null,
    // The read already holds one page, of the size the person chose; the
    // table lists all of it.
    perPage: 0,
    page: 1,
  });
  const [prefs, setPrefs] = useState<FleetPrefs>(savedPrefs);
  const [picking, setPicking] = useState(false);
  const [reading, startReading] = useTransition();
  const [pausing, setPausing] = useState<RunRow | null>(null);
  const { toasts, toast } = useToasts();
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [, startExport] = useTransition();
  const columns = shownColumns(prefs);

  const all = useMemo(
    () =>
      listRuns(runs, parkedRunIds(approvals.ok ? approvals.value.items : [])),
    [runs, approvals],
  );
  const listed = useMemo(() => chipRows(all, chip), [all, chip]);
  const words = useRowWords(listed);
  const page = applyList(listed, words, query);

  /** Apply a choice now and remember it in this browser for a year. */
  function save(next: FleetPrefs) {
    setPrefs(next);
    document.cookie = fleetPrefsCookieString(
      next,
      document.URL.startsWith("https:"),
    );
  }

  // The page size is the read's limit, so a new size reads again from the
  // newest run: the page re-renders on the server with the saved cookie.
  function changePageSize(size: PageSize) {
    if (size === prefs.pageSize) return;
    save({ ...prefs, pageSize: size });
    startReading(() => {
      if (cursor === null) navigate.refresh();
      else navigate.push(routes.fleet(org, ws, { prs: pullRequests }));
    });
  }

  // The filter is the read's filter and lives in the URL, so a filtered
  // Fleet can be linked, and a new filter starts from the newest run.
  function changeFilter(next: PullRequestFilter) {
    if (next === pullRequests) return;
    startReading(() => {
      navigate.push(routes.fleet(org, ws, { prs: next }));
    });
  }

  function sortBy(key: SortKey) {
    const current = query.sort;
    const sort =
      current?.key !== key
        ? { key, dir: 1 as const }
        : current.dir === 1
          ? { key, dir: -1 as const }
          : null;
    setQuery({ ...query, sort, page: 1 });
  }

  function exportRow(run: RunRow) {
    setExportingId(run.id);
    startExport(async () => {
      try {
        const result = await exportFleetRun(org, ws, run.id);
        if (result.ok) toast(t("exportQueued", { run: run.id }));
        else
          toast(
            t("exportFailed", { run: run.id, reason: failureText(result) }),
            "failed",
          );
      } catch {
        toast(
          t("exportFailed", {
            run: run.id,
            reason: failureText(UNANSWERED),
          }),
          "failed",
        );
      } finally {
        setExportingId(null);
      }
    });
  }

  const emptyText =
    runs.length > 0 || pullRequests === "any"
      ? t("noMatch")
      : pullRequests === "with"
        ? t("prFilter.noneWith")
        : t("prFilter.noneWithout");

  return (
    <>
      <Tiles
        listed={listed}
        approvals={approvals}
        agentTotal={agentTotal}
        now={now}
      />
      <section aria-labelledby="fleet-runs" className={panel}>
        <div className={panelHeader}>
          <h2 id="fleet-runs" className={panelTitle}>
            {t("title")}
          </h2>
          <Chips
            chip={chip}
            onChip={(next) => {
              setChip(next);
              setQuery({ ...query, page: 1 });
            }}
          />
        </div>
        <ListBar
          query={query}
          setQuery={setQuery}
          words={words}
          pageSize={prefs.pageSize}
          onPageSize={changePageSize}
          pullRequests={pullRequests}
          onPullRequests={changeFilter}
          onColumns={() => {
            setPicking(true);
          }}
        />
        {pullRequestsUnread ? (
          <p
            role="status"
            data-testid="prs-unread"
            className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {t("prs.unread")}
          </p>
        ) : null}
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-labelledby="fleet-runs"
            aria-busy={reading}
            data-testid="runs-table"
            className={`w-full min-w-[560px] border-collapse text-[13px] ${reading ? "opacity-60" : ""}`}
          >
            <thead>
              <tr className="border-b border-border">
                {columns.map((key) => {
                  const head = COLUMN_HEAD[key];
                  const label = t(`columns.${key}`);
                  const align =
                    head.numeric === true ? "text-right" : "text-left";
                  const sortKey = head.sort;
                  if (sortKey === null)
                    return (
                      <th
                        key={key}
                        scope="col"
                        className={`${headCell} ${align}`}
                      >
                        {label}
                      </th>
                    );
                  // The design's Tokens header sorts. list_runs carries no
                  // token figure yet (G3, #3834), so every cell reads "not
                  // recorded" and there is no order to put them in. The
                  // control is drawn where the design has it, disabled, and
                  // its hover says why.
                  if (sortKey === "tokens")
                    return (
                      <th
                        key={key}
                        scope="col"
                        aria-sort="none"
                        className={`${headCell} ${align}`}
                      >
                        <button
                          type="button"
                          disabled
                          data-testid="sort-tokens"
                          aria-label={t("sortBy", { column: label })}
                          title={t("tokensUnsorted")}
                          className="inline-flex cursor-not-allowed items-center gap-1 uppercase tracking-[inherit]"
                        >
                          {label}
                          <ArrowUpDown aria-hidden className="size-3" />
                        </button>
                      </th>
                    );
                  const sorted =
                    query.sort?.key === sortKey ? query.sort.dir : 0;
                  return (
                    <th
                      key={key}
                      scope="col"
                      aria-sort={
                        sorted === 1
                          ? "ascending"
                          : sorted === -1
                            ? "descending"
                            : "none"
                      }
                      className={`${headCell} ${align}`}
                    >
                      <button
                        type="button"
                        aria-label={t("sortBy", { column: label })}
                        onClick={() => {
                          sortBy(sortKey);
                        }}
                        className="inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {label}
                        <ArrowUpDown aria-hidden className="size-3" />
                      </button>
                    </th>
                  );
                })}
                <th scope="col" className={headCell}>
                  <span className="sr-only">{t("actionsColumn")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
              {page.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    data-testid="runs-none"
                    className="px-4 py-[18px] text-center text-dim"
                  >
                    {emptyText}
                  </td>
                </tr>
              ) : (
                page.rows.map((index) => {
                  const row = listed[index];
                  return row === undefined ? null : (
                    <RunRowView
                      key={row.run.id}
                      listed={row}
                      columns={columns}
                      now={now}
                      org={org}
                      ws={ws}
                      exporting={exportingId === row.run.id}
                      onPause={(run) => {
                        setPausing(run);
                      }}
                      onExport={exportRow}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <Pager
          from={page.from}
          to={page.to}
          total={page.total}
          more={nextCursor !== null}
          org={org}
          ws={ws}
          cursor={cursor}
          nextCursor={nextCursor}
          pullRequests={pullRequests}
        />
      </section>
      <ColumnPicker
        open={picking}
        onOpenChange={setPicking}
        prefs={prefs}
        onChange={save}
      />
      {/* The design confirms an export or a queued pause with a toast. */}
      <ToastStack toasts={toasts} testId="runs-toasts" />
      <PauseDialog
        run={pausing}
        canCommand={canCommand}
        org={org}
        ws={ws}
        onClose={() => {
          setPausing(null);
        }}
        onQueued={(run) => {
          setPausing(null);
          toast(pauseT("queued", { run: run.id }), "approval");
          navigate.refresh();
        }}
      />
    </>
  );
}
