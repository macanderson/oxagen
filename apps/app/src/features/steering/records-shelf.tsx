"use client";
// The Library's Records shelf body (roadmap pages/steering-records.md): the
// Published records panel with its kind chips, Sort, Rows and a numbered
// pager over record cards, newest first, and the closing note.
//
// The shelf reads every record in force once (./library-read.ts) and the list
// tools work over those rows in the browser, as the design's do. The kind
// chips are links, so a kind has an address and the back button walks it;
// Sort, Rows and the page are the reader's own view of the list and stay in
// the browser.
//
// Each card prints what the record carries and derives only what the record
// fully determines. The token cost is the assembler's own count of the line
// the signed bundle carries for the record, so it is computed, not guessed.
// "new · bundle vN" marks a record whose commit is the head the last merge
// published at. Whether a record carries an enforcement grant, and its effect
// line (rendered, cited, violated), have no store yet: each prints "not
// recorded" and names the issue that tracks it.
import {
  ArrowRight,
  Bookmark,
  CircleDot,
  Heart,
  List,
  type LucideIcon,
  ShieldMinus,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  RECORD_KINDS,
  type RecordKind,
  type RecordPage,
} from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  inputBase,
  panel,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { pageNumbers } from "@/ui/faceted-list-table";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { PressLink } from "@/ui/press-link";
import { STEERING_GAPS } from "./gaps";
import { budgetTokens } from "./tokens";
import { type SteeringAt, steeringLink } from "./view";

export type PublishedRecord = RecordPage["records"][number];

/** The bundle the last merge published: its version and the commit it published at. */
export type BundleHead = { version: number; headCommit: string | null };

/** A kind is an icon and a hue, never a hue alone (globals.css `--kind-*`). */
const KIND_FACE: Record<
  RecordKind,
  { icon: LucideIcon; ink: string; bar: string; tile: string }
> = {
  rule: {
    icon: ArrowRight,
    ink: "text-kind-rule",
    bar: "border-l-kind-rule",
    tile: "border-kind-rule/40 bg-kind-rule/10",
  },
  constraint: {
    icon: ShieldMinus,
    ink: "text-kind-constraint",
    bar: "border-l-kind-constraint",
    tile: "border-kind-constraint/40 bg-kind-constraint/10",
  },
  procedure: {
    icon: List,
    ink: "text-kind-procedure",
    bar: "border-l-kind-procedure",
    tile: "border-kind-procedure/40 bg-kind-procedure/10",
  },
  fact: {
    icon: CircleDot,
    ink: "text-kind-fact",
    bar: "border-l-kind-fact",
    tile: "border-kind-fact/40 bg-kind-fact/10",
  },
  memory: {
    icon: Bookmark,
    ink: "text-kind-memory",
    bar: "border-l-kind-memory",
    tile: "border-kind-memory/40 bg-kind-memory/10",
  },
  preference: {
    icon: Heart,
    ink: "text-kind-preference",
    bar: "border-l-kind-preference",
    tile: "border-kind-preference/40 bg-kind-preference/10",
  },
};

/** The design's Rows choices; 0 is every record on one page. */
const PER_PAGE = [5, 10, 25, 50, 0] as const;
type Sort = "shown" | "asc" | "desc";
const SORTS: readonly Sort[] = ["shown", "asc", "desc"];

/**
 * What the record costs in the assembler: the tokens of the line the signed
 * bundle carries for it, `- <statement> (<kind>; <lineage>)`, as
 * `recordCandidate` (packages/handlers/src/lib/tacho-steering.ts) builds it
 * and `assembleSteering` counts it. Null for a record with no force or no
 * statement, which the assembler drops before counting.
 */
export function recordTokens(record: PublishedRecord): number | null {
  const statement = record.statement?.trim() ?? "";
  if (record.force === null || statement === "") return null;
  const kind =
    record.kind === "constraint" && record.constraintEffect !== null
      ? `constraint, ${record.constraintEffect}`
      : (record.kind ?? "record");
  return budgetTokens(
    `- ${record.statement ?? ""} (${kind}; ${record.lineage})`,
  );
}

/** Whether the record's commit is the head the last merge published at. */
export function publishedByLastMerge(
  record: PublishedRecord,
  bundle: BundleHead | null,
): boolean {
  const head = bundle?.headCommit ?? null;
  const commit = record.commit;
  if (head === null || commit === null) return false;
  return head.startsWith(commit) || commit.startsWith(head);
}

/** Newest first, then the reader's sort by statement; the order is stable. */
export function sortRecords(
  records: readonly PublishedRecord[],
  sort: Sort,
): PublishedRecord[] {
  const statementOf = (r: PublishedRecord) => r.statement ?? r.title;
  const shown = [...records].sort((a, b) => {
    // A record with no publication date sorts after every dated one.
    if (a.publishedAt === b.publishedAt) return 0;
    if (a.publishedAt === null) return 1;
    if (b.publishedAt === null) return -1;
    return a.publishedAt < b.publishedAt ? 1 : -1;
  });
  if (sort === "shown") return shown;
  const dir = sort === "asc" ? 1 : -1;
  return shown.sort(
    (a, b) =>
      statementOf(a).localeCompare(statementOf(b), undefined, {
        sensitivity: "base",
      }) * dir,
  );
}

function KindIcon({
  kind,
  className,
}: {
  kind: RecordKind;
  className: string;
}) {
  const Icon = KIND_FACE[kind].icon;
  return <Icon aria-hidden="true" className={className} strokeWidth={1.8} />;
}

const chip = `${buttonSecondary} min-h-7 gap-1.5 px-2.5 py-1 text-[12.5px] aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`;
const select = `${inputBase} w-auto min-h-8 max-md:min-h-11 max-md:text-base py-1.5 pr-8`;
const meta =
  "flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground";

function KindChips({
  at,
  kind,
  counts,
  all,
}: {
  at: SteeringAt;
  kind: RecordKind | null;
  counts: Record<RecordKind, number>;
  all: number;
}) {
  const t = useTranslations("steering.records");
  const record = useTranslations("ui.record");
  const locale = useLocale();
  return (
    <div
      role="group"
      aria-label={t("filter")}
      data-testid="record-kinds"
      className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5"
    >
      <PressLink
        to={steeringLink(at, { tab: "records" })}
        pressed={kind === null}
        data-kind="all"
        className={chip}
      >
        {t("all")}
        <span className="font-mono text-[11px] text-dim">
          {formatCount(all, locale)}
        </span>
      </PressLink>
      {RECORD_KINDS.map((k) => (
        <PressLink
          key={k}
          to={steeringLink(at, { tab: "records", kind: k })}
          pressed={kind === k}
          data-kind={k}
          className={chip}
        >
          <KindIcon kind={k} className={`size-3.5 ${KIND_FACE[k].ink}`} />
          {record(`kinds.${k}`)}
          <span className="font-mono text-[11px] text-dim">
            {formatCount(counts[k], locale)}
          </span>
        </PressLink>
      ))}
    </div>
  );
}

function RecordShelfCard({
  at,
  record,
  bundle,
}: {
  at: SteeringAt;
  record: PublishedRecord;
  bundle: BundleHead | null;
}) {
  const t = useTranslations("steering.records");
  const ui = useTranslations("ui.record");
  const locale = useLocale();
  const face = record.kind === null ? null : KIND_FACE[record.kind];
  const tokens = recordTokens(record);
  const freshIn =
    bundle !== null && publishedByLastMerge(record, bundle) ? bundle : null;
  return (
    <article
      data-kind={record.kind ?? "unclassified"}
      data-lineage={record.lineage}
      className={`flex gap-3 border-b border-l-[3px] border-b-border px-4 py-3.5 max-md:flex-col ${face?.bar ?? "border-l-border"}`}
    >
      <span
        aria-hidden="true"
        className={`grid size-8 flex-none place-items-center rounded-lg border ${face === null ? "border-border" : `${face.tile} ${face.ink}`}`}
      >
        {record.kind === null ? null : (
          <KindIcon kind={record.kind} className="size-4" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-term="kind"
            className={`inline-flex items-center gap-1 rounded-md border px-[7px] py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] ${face === null ? "border-border text-muted-foreground" : `${face.tile} ${face.ink}`}`}
          >
            {record.kind === null ? null : (
              <KindIcon kind={record.kind} className="size-3" />
            )}
            {record.kind === null
              ? ui("unclassified")
              : ui(`kinds.${record.kind}`)}
          </span>
          {record.force === null ? null : (
            <span title={t("forceTitle")}>
              <Badge tone="quiet" dot={false} data-term="force">
                {record.force}
              </Badge>
            </span>
          )}
          {record.constraintEffect === null ? null : (
            <span title={t("effectTitle")}>
              <Badge
                tone={
                  record.constraintEffect === "forbid" ? "denied" : "approval"
                }
                dot={false}
                data-term="constraint-effect"
              >
                {ui(`effects.${record.constraintEffect}`)}
              </Badge>
            </span>
          )}
          {tokens === null ? null : (
            <span title={t("tokensTitle")}>
              <Badge tone="quiet" dot={false} mono data-term="tokens">
                {t("tokens", { count: formatCount(tokens, locale) })}
              </Badge>
            </span>
          )}
          <span
            title={t("compilesTitle", {
              issue: String(STEERING_GAPS.registry),
            })}
          >
            <Badge
              tone="quiet"
              dot={false}
              data-term="compiles"
              data-compiles="not-recorded"
            >
              {t("compilesNotRecorded")}
            </Badge>
          </span>
          <span className="ms-auto flex flex-wrap items-center gap-1.5">
            {freshIn === null ? null : (
              <span title={t("newTitle")}>
                <Badge tone="proven" dot={false} data-term="new">
                  {t("new", { version: String(freshIn.version) })}
                </Badge>
              </span>
            )}
            <Badge tone="allowed" data-term="state">
              {t("published")}
            </Badge>
            <SafeLink
              to={routes.steeringRecord(at.org, at.ws, record.lineage)}
              className={`${buttonSecondary} min-h-7 px-2.5 py-1 text-[12.5px]`}
              aria-label={t("openLabel", { lineage: record.lineage })}
            >
              {t("open")}
            </SafeLink>
          </span>
        </div>
        <p className="text-[14px] text-foreground">
          {record.statement ?? record.title}
        </p>
        <div className={meta} data-term="meta">
          <b className="font-semibold text-foreground" data-term="scope">
            {ui(`scopes.${record.sharingScope}`)}
          </b>
          <span
            data-term="effect"
            data-effect="not-recorded"
            title={t("effectLineTitle", {
              issue: String(STEERING_GAPS.effect),
            })}
          >
            {t("effectNotRecorded")}
          </span>
          <span
            className="break-all font-mono text-[11.5px]"
            data-term="lineage"
          >
            {record.lineage}
          </span>
          {record.commit === null ? null : (
            <span className="font-mono text-[11.5px]" data-term="commit">
              {record.commit.slice(0, 7)}
            </span>
          )}
          {record.publishedAt === null ? null : (
            <span data-term="published">{record.publishedAt.slice(0, 10)}</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function RecordsList({
  at,
  kind,
  records,
  total,
  bundle,
}: {
  at: SteeringAt;
  /** The kind the URL presses; null is All. */
  kind: RecordKind | null;
  /** Every record in force the shelf read. */
  records: readonly PublishedRecord[];
  /** Every record in force, read or not. */
  total: number;
  /** The last merge's bundle; null when the freshness read failed. */
  bundle: BundleHead | null;
}) {
  const t = useTranslations("steering.records");
  const list = useTranslations("ui.list");
  const locale = useLocale();
  const [sort, setSort] = useState<Sort>("shown");
  const [per, setPer] = useState<number>(10);
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const byKind: Record<RecordKind, number> = {
      rule: 0,
      constraint: 0,
      procedure: 0,
      fact: 0,
      memory: 0,
      preference: 0,
    };
    for (const record of records) {
      if (record.kind !== null) byKind[record.kind] += 1;
    }
    return byKind;
  }, [records]);

  const shown = useMemo(
    () =>
      sortRecords(
        kind === null ? records : records.filter((r) => r.kind === kind),
        sort,
      ),
    [records, kind, sort],
  );
  const count = shown.length;
  const size = per === 0 ? Math.max(count, 1) : per;
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(page, pages);
  const slice = shown.slice((current - 1) * size, current * size);
  const from = count === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(count, current * size);

  return (
    <section
      aria-labelledby="steering-records"
      data-testid="records-panel"
      className={panel}
    >
      <div className={panelHeader}>
        <h3 id="steering-records" className={panelTitle}>
          {t("title")}
        </h3>
      </div>
      <KindChips at={at} kind={kind} counts={counts} all={records.length} />
      <div
        data-list-tools=""
        className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-4 py-2.5"
      >
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {t("sort")}
          <select
            className={select}
            data-sort=""
            value={sort}
            onChange={(event) => {
              const next = SORTS.find((s) => s === event.target.value);
              setSort(next ?? "shown");
              setPage(1);
            }}
          >
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`sorts.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {list("rows")}
          <select
            className={select}
            data-rows=""
            value={per}
            onChange={(event) => {
              setPer(Number(event.target.value));
              setPage(1);
            }}
          >
            {PER_PAGE.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? list("allRows") : n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {slice.length === 0 ? (
        <p
          data-state="empty-kind"
          className="px-4 py-3.5 text-[13px] text-muted-foreground"
        >
          {t("emptyKind")}
        </p>
      ) : (
        <div data-testid="record-cards">
          {slice.map((record) => (
            <RecordShelfCard
              key={record.id}
              at={at}
              record={record}
              bundle={bundle}
            />
          ))}
        </div>
      )}
      <nav
        aria-label={list("pager")}
        data-testid="records-pager"
        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[12px]"
      >
        <span className="font-mono text-dim" data-range="">
          {count === 0
            ? list("rangeEmpty")
            : list("range", {
                from: formatCount(from, locale),
                to: formatCount(to, locale),
                total: formatCount(count, locale),
              })}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-[12px]`}
            aria-label={list("previous")}
            disabled={current === 1}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            ‹
          </button>
          {pageNumbers(current, pages).map((n, index) =>
            n === "gap" ? (
              <span key={`gap-${String(index)}`} className="px-1 text-dim">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-[12px] aria-[current=page]:border-gold`}
                aria-label={list("page", { page: String(n) })}
                aria-current={n === current ? "page" : undefined}
                onClick={() => {
                  setPage(n);
                }}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-[12px]`}
            aria-label={list("next")}
            disabled={current === pages}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            ›
          </button>
        </span>
      </nav>
      {records.length < total ? (
        <p
          data-testid="records-truncated"
          className="border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground"
        >
          {t("truncated", {
            read: formatCount(records.length, locale),
            total: formatCount(total, locale),
          })}
        </p>
      ) : null}
      <div className="border-t border-border px-4 py-3.5">
        <p
          data-testid="records-note"
          className="border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground"
        >
          {t.rich("note", {
            effects: "constraint_effect ∈ {require, forbid}",
            code: (chunks) => (
              <code className="font-mono text-[12px]">{chunks}</code>
            ),
          })}
        </p>
      </div>
    </section>
  );
}
