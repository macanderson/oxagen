"use client";
// The agents registered in a workspace (mockups/pages/agents.md, "Registered
// in <workspace>"): one table with two column sets over the same rows, and the
// list controls the mockup's `listify()` adds to it.
//
// **The column set is session state.** It lives in this component, not in the
// URL, so a link to the page always lands on Composition. Switching changes
// which columns render and never which agents are listed: the search, the
// facets that are still in view, the sort and the page survive a switch.
//
// **Each row names its runtime and its toolbelt** (ADR-198): the Toolbelt
// column is the belt the agent carries and the Runtime column the runtime it
// runs on, above the host it enrolled from.
//
// **A column no store backs says so in every row.** Steering and the Belt
// width have no per-agent record yet (#3296), and no store records a
// runtime's kind (#3816), so each prints the not-recorded words, naming the
// missing store on hover, rather than a count someone typed. Every header
// still sorts, as the design's list controls do; a column with nothing
// recorded sorts as a tie. Spend 30d and Tokens 30d are the wrapped sessions'
// figures and say so under each number. The Tier and Health cells read the
// tier the agent's latest wrapped session recorded and the open tamper
// incidents on its hosts, and show that and nothing stronger: an enrolled
// agent with no recorded tier has no health verdict. The Incidents column
// counts every tamper incident the store keeps on the agent's hosts, the set
// the Tamper incidents tile sums.
//
// **The controls work over the rows in hand.** The read asks for the
// contract's largest page; a workspace with more agents than that pages the
// rest through the cursor link under the pager.
//
// **A retired row is a deleted record.** It is listed only when a person
// chose to show deregistered agents. It is dimmed, and its actions cell holds
// a Deregistered badge and no action: nothing can be assigned to it.
//
// **The managed row is Oxagen's.** stella acts as the built-in assistant
// (`qa-chat`), and deregistering it stopped stella in the workspace (#4350).
// Its actions cell holds a badge and no action; the agent's page keeps the
// kill switch, which is how a person stops stella.
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import type { AgentPage } from "@/data/contracts/agents";
import { routes, type SafePath } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  inputBase,
  linkText,
  mono,
  panel,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { pageList } from "@/ui/page-list";
import { cell, headCell, numericCell } from "@/ui/table";
import { RetireAgent } from "./agent-actions";
import { AgentStatusBadge, NotRecordedValue } from "./parts";
import { AssignRole } from "./role-controls";

type AgentRow = AgentPage["agents"][number];
type ColumnSet = "composition" | "operations";

/** The page sizes the Rows control offers; `0` is All. */
const PAGE_SIZES = [5, 10, 25, 50, 0] as const;
const DEFAULT_PAGE_SIZE = 10;
/** The most facet selects the controls draw, as `listify()` does. */
const MAX_FACETS = 3;
/** A column with more distinct values than this is a poor filter. */
const MAX_FACET_VALUES = 8;
/** A list shorter than this offers no facet (`ltFacets`). */
const MIN_FACET_ROWS = 4;
/** A value longer than this is prose, not an enumeration (`ltFacets`). */
const MAX_FACET_VALUE_LENGTH = 28;
/**
 * The design's status-like column names (`LT_FACET` in the mockup's engine),
 * whose facets come first. Matched against the column's key, not its
 * translated label, so the order is the same in every locale.
 */
const STATUS_LIKE =
  /status|state|tier|kind|role|risk|severity|result|health|effect|mode|side|level|verdict|decision|origin|scope|period|basis|algorithm|trend|position|governance/i;

type Health = "tamper" | "notEnrolled" | "observe" | "healthy";

/**
 * The Health verdict (agents.md, `agentHealth()`), in the spec's order: an open
 * tamper incident, then no enrollment, then the observe tier. A retired agent
 * has no enrollment: `retire_agent` revokes its credential and every host, so
 * it reads `not enrolled` whatever tier its last session recorded. Null when
 * the record supports no verdict: a suspended agent, whose principal is
 * refused at every call, and an enrolled agent no wrapped session has
 * recorded a tier for. "healthy" would then be a claim the record does not
 * make.
 */
function healthOf(row: AgentRow): Health | null {
  if (row.tamperIncidents > 0) return "tamper";
  if (row.status === "unenrolled" || row.status === "retired")
    return "notEnrolled";
  if (row.status === "suspended") return null;
  if (row.enforcementTier === null) return null;
  if (row.enforcementTier === "observe") return "observe";
  return "healthy";
}

const HEALTH_TONE = {
  tamper: "critical",
  notEnrolled: "quiet",
  observe: "approval",
  healthy: "allowed",
} as const;

type Column = {
  key: string;
  label: string;
  numeric?: boolean;
  /** The value the header sorts by; a column without one does not sort. */
  sort?: (row: AgentRow) => string | number | null;
  /** The value a facet filters on; a column without one offers no facet. */
  facet?: (row: AgentRow) => string | null;
  render: (row: AgentRow) => ReactNode;
};

type Sort = { key: string; dir: "ascending" | "descending" };

function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

function Owner({ row }: { row: AgentRow }) {
  if (row.operatorId === null) return <NotRecordedValue />;
  return (
    <span className="inline-flex items-center gap-[7px] whitespace-nowrap">
      <Avatar
        value={row.operatorAvatarUrl}
        initials={initialsOf(row.operatorName ?? row.operatorId)}
        size={22}
        testId="operator-avatar"
      />
      <OperatorName
        operator={{
          id: row.operatorId,
          name: row.operatorName,
          kind: "human",
          avatarUrl: row.operatorAvatarUrl,
        }}
      />
    </span>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return (
    <span className="block font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function HealthBadge({ row }: { row: AgentRow }) {
  const t = useTranslations("agents.list.health");
  const tier = useTranslations("agents.tier");
  const health = healthOf(row);
  if (health === null && row.status === "suspended") {
    return (
      <span title={t("suspendedWhy")} data-health="none">
        <span aria-hidden="true" className="text-muted-foreground">
          —
        </span>
        <span className="sr-only">{t("suspendedWhy")}</span>
      </span>
    );
  }
  if (health === null) return <NotRecordedValue gap="tier" />;
  // Each explanation names the record the verdict rests on and nothing more:
  // "healthy" is an enrolled agent with no open tamper incident whose latest
  // wrapped session recorded a tier above observe. No store records frame
  // arrival or a chain check per agent, so the words do not claim either.
  const why =
    health === "tamper"
      ? t("tamperWhy", { count: row.tamperIncidents })
      : health === "healthy"
        ? t("healthyWhy", {
            tier: row.enforcementTier === null ? "" : tier(row.enforcementTier),
          })
        : health === "notEnrolled" && row.status === "retired"
          ? t("retiredWhy")
          : t(`${health}Why`);
  return (
    <span title={why} className="inline-flex flex-col gap-0.5">
      <Badge tone={HEALTH_TONE[health]} data-health={health}>
        {t(health)}
      </Badge>
      <span className="sr-only">{why}</span>
    </span>
  );
}

function TierWord({ row }: { row: AgentRow }) {
  const t = useTranslations("agents.tier");
  if (row.enforcementTier === null) return <NotRecordedValue gap="tier" />;
  return (
    <Badge tone="quiet" dot={false} mono data-tier={row.enforcementTier}>
      {t(row.enforcementTier)}
    </Badge>
  );
}

/** The sort key of a column no store records: every row ties. */
const notRecorded = (): null => null;

/**
 * Tokens 30d: the wrapped sessions' reported total over the share of input
 * read from cache. The sub-line says the figure is the wrapped sessions',
 * because ledger runs' tokens are not in the total (#3853) and a bare number
 * would claim they were; the hover adds the session count.
 */
function Tokens({ row }: { row: AgentRow }) {
  const t = useTranslations("agents.list.cells");
  const locale = useLocale();
  const tokens = row.tokens30d;
  if (tokens === null) return <NotRecordedValue gap="tokens" />;
  return (
    <span
      data-basis="wrapped_sessions"
      title={t("tokensBasis", { count: tokens.sessions })}
    >
      {formatCount(tokens.total, locale)}
      <Sub>
        {tokens.cacheReadRate === null
          ? t("cacheNotRecorded")
          : t("cached", { rate: formatRatio(tokens.cacheReadRate, locale) })}
        {" · "}
        {t("wrappedOnly")}
      </Sub>
    </span>
  );
}

function useColumns(set: ColumnSet, org: string, ws: string): Column[] {
  const t = useTranslations("agents");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const harness = (row: AgentRow) => t(`harness.${row.harness}`);
  const agent = (sub: (row: AgentRow) => ReactNode): Column => ({
    key: "agent",
    label: t("list.columns.agent"),
    sort: (row) => row.agentKey ?? row.slug,
    render: (row) => (
      <SafeLink
        to={routes.agent(org, ws, row.slug)}
        onClick={(event) => {
          event.stopPropagation();
        }}
        className="block rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        <AgentCard
          agentKey={row.agentKey}
          notRecorded={t("notRecorded")}
          sub={sub(row)}
        />
      </SafeLink>
    ),
  });
  const actions: Column = {
    key: "actions",
    label: t("list.columns.actions"),
    render: (row) => <RowActions row={row} org={org} ws={ws} />,
  };
  const owner = (key: "owner" | "operator"): Column => ({
    key,
    label: t(`list.columns.${key}`),
    sort: (row) => row.operatorName,
    facet: (row) => row.operatorName,
    render: (row) => <Owner row={row} />,
  });

  if (set === "composition")
    return [
      agent(harness),
      {
        key: "purpose",
        label: t("list.columns.purpose"),
        sort: (row) => row.description,
        render: (row) =>
          row.description === null ? (
            <NotRecordedValue />
          ) : (
            <span className="block max-w-[26ch] text-xs">
              {row.description}
            </span>
          ),
      },
      owner("owner"),
      {
        key: "steering",
        label: t("list.columns.steering"),
        sort: notRecorded,
        render: () => <NotRecordedValue gap="steering" />,
      },
      {
        key: "toolbelt",
        label: t("list.columns.toolbelt"),
        sort: (row) => row.toolbelt?.name ?? null,
        render: (row) =>
          row.toolbelt === null ? (
            <NotRecordedValue />
          ) : (
            <span data-testid="agent-row-belt">{row.toolbelt.name}</span>
          ),
      },
      {
        key: "runtime",
        label: t("list.columns.runtime"),
        sort: (row) => row.runtime?.name ?? row.host,
        render: (row) => (
          <span className="block">
            {row.runtime === null ? null : (
              <span data-testid="agent-row-runtime" className="block">
                {row.runtime.name}
              </span>
            )}
            <span className={`${mono} block text-[11.5px]`}>
              {row.host ?? t("list.cells.none")}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {/* With no host there is no runtime to have a kind, so the
                  line is the tier alone, as the design draws it. */}
              {row.host === null ? null : (
                <>
                  <NotRecordedValue gap="runtimeKind" />
                  {" · "}
                </>
              )}
              {row.enforcementTier === null ? (
                <NotRecordedValue gap="tier" />
              ) : (
                t(`tier.${row.enforcementTier}`)
              )}
            </span>
          </span>
        ),
      },
      {
        key: "principal",
        label: t("list.columns.principal"),
        sort: (row) => row.principalId,
        render: (row) => (
          <span className={`${mono} text-[11px] text-muted-foreground`}>
            {row.principalId ?? t("list.cells.principalPending")}
          </span>
        ),
      },
      {
        key: "health",
        label: t("list.columns.health"),
        sort: (row) => healthOf(row),
        facet: (row) => {
          const health = healthOf(row);
          return health === null ? null : t(`list.health.${health}`);
        },
        render: (row) => <HealthBadge row={row} />,
      },
      {
        key: "activity",
        label: t("list.columns.activity"),
        numeric: true,
        sort: (row) => row.runs30d,
        render: (row) => (
          <>
            {count(row.runs30d)}
            <Sub>{t("list.cells.runs30d")}</Sub>
          </>
        ),
      },
      actions,
    ];

  return [
    agent((row) => row.description ?? t("notRecorded")),
    {
      key: "harness",
      label: t("list.columns.harness"),
      sort: harness,
      facet: harness,
      render: (row) => (
        <>
          {harness(row)}
          <Sub>{row.harness}</Sub>
        </>
      ),
    },
    owner("operator"),
    {
      key: "status",
      label: t("list.columns.status"),
      sort: (row) => row.status,
      facet: (row) => t(`status.${row.status}`),
      render: (row) => <AgentStatusBadge status={row.status} />,
    },
    {
      key: "tier",
      label: t("list.columns.tier"),
      sort: (row) => row.enforcementTier,
      facet: (row) =>
        row.enforcementTier === null ? null : t(`tier.${row.enforcementTier}`),
      render: (row) => <TierWord row={row} />,
    },
    {
      key: "belt",
      label: t("list.columns.belt"),
      numeric: true,
      sort: notRecorded,
      render: () => <NotRecordedValue gap="belt" />,
    },
    {
      key: "runs",
      label: t("list.columns.runs"),
      numeric: true,
      sort: (row) => row.runs30d,
      render: (row) => count(row.runs30d),
    },
    {
      key: "spend",
      label: t("list.columns.spend"),
      numeric: true,
      sort: (row) =>
        row.spend30d === null ? null : Number(row.spend30d.micros),
      // Priced wrapped sessions only: the sub-line names who observed the
      // figure and that it is the wrapped sessions', and the hover says what
      // it leaves out, since Runs 30d beside it counts ledger runs too.
      render: (row) =>
        row.spend30d === null ? (
          <NotRecordedValue />
        ) : (
          <span
            data-basis="wrapped_sessions"
            title={t("list.cells.spendBasis")}
          >
            <Money value={row.spend30d} />
            <Sub>
              {row.spend30d.basis === null
                ? t("list.basisNotRecorded")
                : t(`list.costBasis.${row.spend30d.basis}`)}
              {" · "}
              {t("list.cells.wrappedOnly")}
            </Sub>
          </span>
        ),
    },
    {
      key: "tokens",
      label: t("list.columns.tokens"),
      numeric: true,
      sort: (row) => row.tokens30d?.total ?? null,
      render: (row) => <Tokens row={row} />,
    },
    {
      key: "mandates",
      label: t("list.columns.mandates"),
      sort: (row) => row.mandates,
      render: (row) =>
        row.mandates === null ? (
          <NotRecordedValue />
        ) : row.mandates === 0 ? (
          <span className="text-muted-foreground">{t("list.cells.none")}</span>
        ) : (
          <Badge tone="approval">{count(row.mandates)}</Badge>
        ),
    },
    {
      key: "incidents",
      label: t("list.columns.incidents"),
      sort: (row) => row.tamperIncidentsRecorded,
      render: (row) =>
        row.tamperIncidentsRecorded === 0 ? (
          <span className="text-muted-foreground">{count(0)}</span>
        ) : (
          <Badge tone="critical">{count(row.tamperIncidentsRecorded)}</Badge>
        ),
    },
    actions,
  ];
}

function RowActions({
  row,
  org,
  ws,
}: {
  row: AgentRow;
  org: string;
  ws: string;
}) {
  const t = useTranslations("agents.list");
  return (
    // The cell swallows the row's click, so an action never opens the agent.
    // It only stops propagation: the controls inside are buttons and links.
    <span
      className="flex items-center gap-1.5 whitespace-nowrap"
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {row.status === "retired" ? (
        <Badge tone="quiet" data-status="retired">
          {t("cells.deregistered")}
        </Badge>
      ) : row.managed ? (
        <span title={t("cells.managedTitle")}>
          <Badge tone="quiet" data-managed="true">
            {t("cells.managed")}
          </Badge>
        </span>
      ) : (
        <>
          <SafeLink
            to={routes.agent(org, ws, row.slug, { tab: "toolbelt" })}
            className={buttonSecondary}
          >
            {t("edit")}
          </SafeLink>
          <AssignRole
            org={org}
            ws={ws}
            agentId={row.id}
            agentSlug={row.slug}
            agentKey={row.agentKey ?? row.slug}
            operatorName={row.operatorName}
            label={t("roles")}
            after={routes.agents(org, ws)}
          />
          <RetireAgent
            org={org}
            ws={ws}
            agentId={row.id}
            name={row.agentKey ?? row.name}
            slug={row.slug}
            holds={{
              mandates: row.mandates ?? 0,
              hosts: row.hosts,
            }}
            after={routes.agents(org, ws)}
            danger
          />
        </>
      )}
    </span>
  );
}

function compare(
  a: string | number | null,
  b: string | number | null,
  sign: 1 | -1,
): number {
  // A value the store did not record sorts last in either direction, so the
  // direction's sign applies only once both values are recorded.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return sign * (a - b);
  return sign * String(a).localeCompare(String(b));
}

function searchText(row: AgentRow, harness: string): string {
  return [
    row.agentKey,
    row.slug,
    row.name,
    row.description,
    row.operatorName,
    row.host,
    row.principalId,
    harness,
  ]
    .filter((part): part is string => part !== null)
    .join(" ")
    .toLowerCase();
}

/**
 * The page buttons the design's `ltPager` draws, zero-based: every page up to
 * seven; past that the first, the current page and its neighbours, and the
 * last, with null for each gap the ellipsis stands in. A pager of 20 pages at
 * page 10 is 1 … 9 10 11 … 20, so it fits a phone's width. The window is the
 * shared list table's (`pageList`), so the two pagers cannot drift apart.
 */
function pagerItems(
  pages: number,
  current: number,
): readonly (number | null)[] {
  return pageList(current + 1, pages).map((item) =>
    typeof item === "number" ? item - 1 : null,
  );
}

export function AgentsTable({
  rows,
  org,
  ws,
  workspace,
  more,
  first,
  retired = null,
}: {
  rows: readonly AgentRow[];
  org: string;
  ws: string;
  /** The workspace's display name. */
  workspace: string;
  /** The next page of the workspace's agents, when the read stopped at its bound. */
  more: SafePath | null;
  /** The first page, when this is a later one. */
  first: SafePath | null;
  /** The link that shows or hides deregistered agents, beside the row range. */
  retired?: ReactNode;
}) {
  const t = useTranslations("agents");
  const locale = useLocale();
  const navigate = useNavigate();
  const [set, setSet] = useState<ColumnSet>("composition");
  const [query, setQuery] = useState("");
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<Sort | null>(null);
  const [size, setSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const columns = useColumns(set, org, ws);

  // Facets are derived from the columns in view, so they differ between the
  // two sets; a facet naming a column that left the view stops filtering.
  // The rule is the design's `ltFacets`: a list of at least four rows; a
  // column of two to eight short values that are not unique per row;
  // status-like columns first, then the one with fewer values; three at most.
  const offered = useMemo(() => {
    if (rows.length < MIN_FACET_ROWS) return [];
    return columns
      .flatMap((column) => {
        const facet = column.facet;
        if (facet === undefined || column.numeric === true) return [];
        const values = [
          ...new Set(rows.map(facet).filter((v): v is string => v !== null)),
        ].sort((a, b) => a.localeCompare(b));
        const enumeration =
          values.length >= 2 &&
          values.length <= MAX_FACET_VALUES &&
          values.length < rows.length &&
          values.every((value) => value.length <= MAX_FACET_VALUE_LENGTH);
        return enumeration ? [{ column, facet, values }] : [];
      })
      .sort(
        (a, b) =>
          Number(!STATUS_LIKE.test(a.column.key)) -
            Number(!STATUS_LIKE.test(b.column.key)) ||
          a.values.length - b.values.length,
      )
      .slice(0, MAX_FACETS);
  }, [columns, rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter(
      (row) =>
        (needle === "" ||
          searchText(row, t(`harness.${row.harness}`)).includes(needle)) &&
        offered.every(
          ({ column, facet }) =>
            (facets[column.key] ?? "") === "" ||
            facet(row) === facets[column.key],
        ),
    );
    const by = columns.find((column) => column.key === sort?.key)?.sort;
    if (sort === null || by === undefined) return filtered;
    const sign = sort.dir === "ascending" ? 1 : -1;
    return [...filtered].sort((a, b) => compare(by(a), by(b), sign));
  }, [rows, query, offered, facets, columns, sort, t]);

  const pages = size === 0 ? 1 : Math.max(1, Math.ceil(visible.length / size));
  const current = Math.min(page, pages - 1);
  const shown =
    size === 0 ? visible : visible.slice(current * size, (current + 1) * size);
  const from = visible.length === 0 ? 0 : size === 0 ? 1 : current * size + 1;
  const to =
    size === 0
      ? visible.length
      : Math.min(visible.length, (current + 1) * size);

  const titleId = "agents-registered";
  return (
    <section aria-labelledby={titleId} className={`${panel} flex flex-col`}>
      <div className={`${panelHeader} items-start`}>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className={panelTitle}>
            {t("list.title", { workspace })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(`list.lead.${set}`)}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t("list.views.label")}
            className="flex flex-nowrap gap-1.5"
          >
            {(["composition", "operations"] as const).map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={set === name}
                data-touch-target=""
                className={`${buttonSecondary} aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`}
                onClick={() => {
                  setSet(name);
                }}
              >
                {t(`list.views.${name}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <input
          type="search"
          value={query}
          aria-label={t("list.controls.search")}
          placeholder={t("list.controls.search")}
          data-touch-target=""
          className={`${inputBase} min-w-40 flex-1`}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        {offered.map(({ column, values }) => (
          <select
            key={column.key}
            aria-label={t("list.controls.facetLabel", { column: column.label })}
            value={facets[column.key] ?? ""}
            data-touch-target=""
            className={`${inputBase} w-auto`}
            onChange={(event) => {
              setFacets((was) => ({
                ...was,
                [column.key]: event.target.value,
              }));
              setPage(0);
            }}
          >
            <option value="">
              {t("list.controls.facetAll", { column: column.label })}
            </option>
            {values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("list.controls.rows")}
          <select
            value={size}
            data-touch-target=""
            className={`${inputBase} w-auto`}
            onChange={(event) => {
              setSize(Number(event.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((option) => (
              <option key={option} value={option}>
                {option === 0
                  ? t("list.controls.all")
                  : formatCount(option, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label={t("list.tableLabel", { workspace })}
          data-column-set={set}
          className="w-full min-w-[560px] border-collapse text-[13px]"
        >
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => {
                const sorted = sort?.key === column.key ? sort.dir : undefined;
                const align =
                  column.numeric === true ? "text-right" : "text-left";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    // The action column's header is empty, as the design
                    // draws it, so a phone card shows its buttons with no
                    // label; the name is for assistive technology alone.
                    aria-label={
                      column.key === "actions" ? column.label : undefined
                    }
                    aria-sort={
                      column.sort === undefined ? undefined : (sorted ?? "none")
                    }
                    className={`${headCell} ${align}`}
                  >
                    {column.key === "actions" ? null : column.sort ===
                      undefined ? (
                      column.label
                    ) : (
                      <button
                        type="button"
                        aria-label={t("list.controls.sortBy", {
                          column: column.label,
                        })}
                        className="inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => {
                          setSort(
                            sorted === "ascending"
                              ? { key: column.key, dir: "descending" }
                              : { key: column.key, dir: "ascending" },
                          );
                        }}
                      >
                        {column.label}
                        {sorted === "ascending" ? (
                          <ArrowUp aria-hidden="true" className="size-3" />
                        ) : sorted === "descending" ? (
                          <ArrowDown aria-hidden="true" className="size-3" />
                        ) : (
                          <ArrowUpDown
                            aria-hidden="true"
                            className="size-3 opacity-50"
                          />
                        )}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
            {shown.map((row) => (
              <tr
                key={row.id}
                data-testid="agent-row"
                data-agent={row.slug}
                data-retired={row.status === "retired" ? "" : undefined}
                className={
                  row.status === "retired"
                    ? "cursor-pointer text-muted-foreground opacity-70"
                    : "cursor-pointer"
                }
                onClick={() => {
                  navigate.push(routes.agent(org, ws, row.slug));
                }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.numeric === true ? numericCell : cell}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr data-testid="agents-no-match">
                <td
                  colSpan={columns.length}
                  className={`${cell} text-center text-muted-foreground`}
                >
                  {t("list.controls.noMatch")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className={`${mono} text-[11px] text-muted-foreground`}>
            {t("list.controls.range", {
              from: formatCount(from, locale),
              to: formatCount(to, locale),
              total: formatCount(visible.length, locale),
            })}
          </span>
          {retired}
        </span>
        {pages > 1 ? (
          <nav aria-label={t("list.controls.pager")} className="flex gap-1">
            <button
              type="button"
              aria-label={t("list.controls.previous")}
              disabled={current === 0}
              data-touch-target=""
              className={buttonSecondary}
              onClick={() => {
                setPage(current - 1);
              }}
            >
              ‹
            </button>
            {pagerItems(pages, current).map((item, position) =>
              item === null ? (
                <span
                  // A gap sits before the current page or after it.
                  key={position === 1 ? "gap-start" : "gap-end"}
                  aria-hidden="true"
                  className="self-center px-1 text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  aria-label={t("list.controls.page", { page: item + 1 })}
                  aria-current={item === current ? "page" : undefined}
                  data-touch-target=""
                  className={`${buttonSecondary} aria-[current=page]:border-gold`}
                  onClick={() => {
                    setPage(item);
                  }}
                >
                  {formatCount(item + 1, locale)}
                </button>
              ),
            )}
            <button
              type="button"
              aria-label={t("list.controls.next")}
              disabled={current === pages - 1}
              data-touch-target=""
              className={buttonSecondary}
              onClick={() => {
                setPage(current + 1);
              }}
            >
              ›
            </button>
          </nav>
        ) : null}
      </div>
      {more === null && first === null ? null : (
        <nav
          aria-label={t("list.controls.cursor")}
          className="flex gap-4 px-4 pb-2.5 text-sm"
        >
          {first === null ? null : (
            <SafeLink to={first} className={linkText}>
              {t("list.first")}
            </SafeLink>
          )}
          {more === null ? null : (
            <SafeLink to={more} className={linkText}>
              {t("list.more")}
            </SafeLink>
          )}
        </nav>
      )}

      <div className="border-t border-border px-4 py-3.5">
        <p className="border-l-2 border-gold pl-3 text-[12.5px] text-muted-foreground">
          {t("list.footer")}
        </p>
      </div>
    </section>
  );
}
