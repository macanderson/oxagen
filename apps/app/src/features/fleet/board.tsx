"use client";
// Fleet's tiles and Runs panel (fleet.md): four summary tiles and the list of
// runs with its filter chips, list controls and per-row action.
//
// One client component holds both, because the filter chips change what the
// tiles add up: Spend shown and Tokens shown are sums over the rows listed,
// and the labels say "shown" for that reason. Every figure here comes from
// `view.ts` over the same rows the table draws.
//
// The list controls run over the rows one `list_runs` read returned (up to the
// contract's 100). The pager says so: its total carries a `+` when the read
// stopped before the oldest run, and a link opens the next read.
import { ArrowUpDown } from "lucide-react";
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
import { acceptsCommands, type RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { openApprovals } from "@/features/shell/client";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
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
import { Clock } from "./clock";
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
  pagerSlots,
  parkedRunIds,
  RUN_CHIPS,
  ROWS_PER_PAGE,
  rowsPerPageOf,
  type RowWords,
  type RunChip,
  type SortKey,
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

const COLUMNS: readonly { key: SortKey | "tokens"; numeric?: boolean }[] = [
  { key: "run" },
  { key: "agent" },
  { key: "operator" },
  { key: "status" },
  { key: "tier" },
  { key: "replay" },
  { key: "tokens", numeric: true },
  { key: "cost", numeric: true },
  { key: "frames", numeric: true },
  { key: "started" },
];

const FACETS = ["tier", "replay", "status"] as const;

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
}: {
  query: ListQuery;
  setQuery: (next: ListQuery) => void;
  words: readonly RowWords[];
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
      <label
        htmlFor={rowsId}
        className="ms-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground"
      >
        {t("rows")}
        <select
          id={rowsId}
          data-testid="rows-per-page"
          value={String(query.perPage)}
          onChange={(event) => {
            setQuery({
              ...query,
              perPage: rowsPerPageOf(event.target.value),
              page: 1,
            });
          }}
          className={selectBase}
        >
          {ROWS_PER_PAGE.map((per) => (
            <option key={per} value={String(per)}>
              {per === 0 ? t("rowsAll") : String(per)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Pager({
  page,
  pages,
  from,
  to,
  total,
  more,
  onPage,
  org,
  ws,
  cursor,
  nextCursor,
}: {
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  /** True when the read stopped before the oldest run. */
  more: boolean;
  onPage: (page: number) => void;
  cursor: string | null;
  nextCursor: string | null;
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
  const pageButton = `${buttonSecondary} min-w-7 px-2 py-0.5 text-xs tabular-nums`;
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground"
    >
      <span data-testid="pager-range" className="font-mono tabular-nums">
        {range}
      </span>
      {cursor === null ? null : (
        <SafeLink
          to={routes.fleet(org, ws)}
          data-touch-target=""
          className={`${linkText} inline-flex items-center`}
        >
          {t("newest")}
        </SafeLink>
      )}
      {nextCursor === null ? null : (
        <SafeLink
          to={routes.fleet(org, ws, { cursor: nextCursor })}
          data-touch-target=""
          className={`${linkText} inline-flex items-center`}
        >
          {t("older")}
        </SafeLink>
      )}
      <span className="ms-auto flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-label={t("previous")}
          data-touch-target=""
          disabled={page <= 1}
          onClick={() => {
            onPage(page - 1);
          }}
          className={pageButton}
        >
          ‹
        </button>
        {pagerSlots(page, pages).map((slot, index) =>
          slot === "gap" ? (
            <span
              key={`gap-${String(index)}`}
              aria-hidden="true"
              className="px-1"
            >
              …
            </span>
          ) : (
            <button
              key={slot}
              type="button"
              aria-label={t("page", { page: slot })}
              aria-current={slot === page ? "page" : undefined}
              data-touch-target=""
              onClick={() => {
                onPage(slot);
              }}
              className={`${pageButton} ${slot === page ? "border-button-primary-border text-accent-text" : ""}`}
            >
              {slot}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label={t("next")}
          data-touch-target=""
          disabled={page >= pages}
          onClick={() => {
            onPage(page + 1);
          }}
          className={pageButton}
        >
          ›
        </button>
      </span>
    </nav>
  );
}

function RunRowView({
  listed,
  now,
  org,
  ws,
  exporting,
  onPause,
  onExport,
}: {
  listed: ListedRun;
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
  return (
    <tr
      data-testid="run-row"
      data-state={state}
      className="cursor-pointer"
      onClick={() => {
        navigate.push(to);
      }}
    >
      <td className={`${cell} min-w-48 max-w-72`}>
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
      <td className={`${cell} min-w-48`}>
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
      <td className={`${cell} whitespace-nowrap`}>
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
      <td className={cell}>
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
      <td className={cell}>
        <TierBadge tier={run.enforcementTier} />
      </td>
      <td className={cell}>
        {run.replayGrade === null ? (
          notRecorded
        ) : (
          <ReplayGradeBadge grade={run.replayGrade} />
        )}
      </td>
      <td className={numericCell}>
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
      <td className={numericCell}>
        {run.cost === null ? (
          notRecorded
        ) : (
          <>
            <Money value={run.cost} />
            <span className="block text-[10px] text-muted-foreground">
              {run.cost.basis ?? t("basisNotRecorded")}
            </span>
          </>
        )}
      </td>
      <td className={numericCell}>{formatCount(run.frames, locale)}</td>
      <td
        className={`${cell} whitespace-nowrap font-mono text-[11px] text-muted-foreground`}
      >
        <Started at={run.startedAt} now={now} />
      </td>
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

/** Why a live run cannot take a pause from Oxagen, or null when it can. */
function pauseRefusal(
  run: RunRow,
  canCommand: boolean,
): "observeReason" | "ledgerReason" | "roleReason" | null {
  if (!acceptsCommands(run.enforcementTier)) return "observeReason";
  if (run.source === "ledger") return "ledgerReason";
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
    perPage: 10,
    page: 1,
  });
  const [pausing, setPausing] = useState<RunRow | null>(null);
  const { toasts, toast } = useToasts();
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [, startExport] = useTransition();

  const all = useMemo(
    () =>
      listRuns(runs, parkedRunIds(approvals.ok ? approvals.value.items : [])),
    [runs, approvals],
  );
  const listed = useMemo(() => chipRows(all, chip), [all, chip]);
  const words = useRowWords(listed);
  const page = applyList(listed, words, query);

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
        <ListBar query={query} setQuery={setQuery} words={words} />
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-labelledby="fleet-runs"
            className="w-full min-w-[560px] border-collapse text-[13px]"
          >
            <thead>
              <tr className="border-b border-border">
                {COLUMNS.map((column) => {
                  const label = t(`columns.${column.key}`);
                  const key = column.key;
                  const align =
                    column.numeric === true ? "text-right" : "text-left";
                  // The design's Tokens header sorts. list_runs carries no
                  // token figure yet (G3, #3834), so every cell reads "not
                  // recorded" and there is no order to put them in. The
                  // control is drawn where the design has it, disabled, and
                  // its hover says why.
                  if (key === "tokens")
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
                  const sorted = query.sort?.key === key ? query.sort.dir : 0;
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
                          sortBy(key);
                        }}
                        className="inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {label}
                        <ArrowUpDown aria-hidden className="size-3" />
                      </button>
                    </th>
                  );
                })}
                <th scope="col" className={headCell} />
              </tr>
            </thead>
            <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
              {page.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="px-4 py-[18px] text-center text-dim"
                  >
                    {t("noMatch")}
                  </td>
                </tr>
              ) : (
                page.rows.map((index) => {
                  const row = listed[index];
                  return row === undefined ? null : (
                    <RunRowView
                      key={row.run.id}
                      listed={row}
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
          page={page.page}
          pages={page.pages}
          from={page.from}
          to={page.to}
          total={page.total}
          more={nextCursor !== null}
          onPage={(next) => {
            setQuery({ ...query, page: next });
          }}
          org={org}
          ws={ws}
          cursor={cursor}
          nextCursor={nextCursor}
        />
      </section>
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
