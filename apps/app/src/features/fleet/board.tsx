"use client";
// Fleet's tiles and Runs panel (fleet.md): four summary tiles and the list of
// runs with its filter chips, list controls and per-row action.
//
// One client component holds both, because the filter chips change what the
// tiles add up: Spend shown and Tokens shown are sums over the rows listed,
// and the labels say "shown" for that reason. Those figures come from
// `view.ts` over the same rows the table draws. Live runs is the workspace's,
// counted by `list_runs` whatever the page or the chips, as its label says.
//
// The page size is the read's own limit, and the search, the facets, the order,
// the page and the pull-request filter are the read's own inputs, values on
// the URL that `list_runs` applies across the workspace (#3837). A change to
// any of them is a navigation (`list-bar.tsx`, the headers), never a filter
// over the rows one read returned. The pager (`pager.tsx`) reads the read's
// total. The page size and the columns shown are the person's saved choice
// (`prefs.ts`), kept in a cookie the page reads on the server. The chips
// filter the rows of the page, because parked comes from the approvals read.
import { ArrowUpDown } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { ApprovalQueue } from "@/data/contracts/approvals";
import type { InterjectionQueue } from "@/data/contracts/interjections";
import {
  type CommandBlock,
  canGoStale,
  commandBlockOf,
  type PullRequestFilter,
  type RunRow,
  STALE_REREAD_MS,
} from "@/data/contracts/runs";
import type { Read } from "@/data/read";
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
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  inputBase,
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
import { cell, headCell, numericCell } from "@/ui/table";
import { LiveRefresh } from "@/ui/live-refresh";
import { ToastStack, useToasts } from "@/ui/toast";
import { dispatchRunCommand, exportFleetRun } from "./actions";
import {
  DiffCell,
  PullRequestsCell,
  RowStatusBadge,
  SummaryCell,
  TokensCell,
  TokensTile,
} from "./run-cells";
import {
  DEFAULT_FLEET_PREFS,
  FIXED_COLUMN,
  FLEET_COLUMNS,
  type FleetColumn,
  type FleetPrefs,
  fleetPrefsCookieString,
  type PageSize,
  shownColumns,
  withColumn,
} from "./prefs";
import { RunsListBar } from "./list-bar";
import {
  effectiveListQuery,
  type FleetListQuery,
  listQueryToRoute,
  nextSort,
  SORTABLE_COLUMNS,
  withList,
} from "./list-query";
import { RunsPager } from "./pager";
import {
  chipRows,
  type ListedRun,
  listRuns,
  parkedRunIds,
  RUN_CHIPS,
  type RunChip,
  shownCost,
  spendShown,
} from "./view";
import { WaitingTile } from "./waiting-tile";

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

function Tiles({
  listed,
  approvals,
  interjections,
  agentTotal,
  liveRuns,
  now,
}: {
  listed: readonly ListedRun[];
  approvals: Read<ApprovalQueue>;
  interjections: Read<InterjectionQueue>;
  agentTotal: number | null;
  /** The workspace's live runs, as `list_runs` counted them; null when it could not. */
  liveRuns: number | null;
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
      {/* Every live run in the workspace, parked ones included, as the Live
          chip lists them. A page of rows could not say how many the
          workspace holds, so a missing count is said, never taken from the
          page. */}
      <Tile
        term={t("live.title")}
        value={
          liveRuns === null ? (
            <span
              data-testid="live-not-counted"
              className="text-base font-medium text-muted-foreground"
            >
              {t("live.notCounted")}
            </span>
          ) : (
            formatCount(liveRuns, locale)
          )
        }
        note={
          agentTotal === null
            ? t("live.basisUnread")
            : t("live.basis", { count: agentTotal })
        }
      />
      <WaitingTile
        approvals={approvals}
        interjections={interjections}
        now={now}
      />
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
      <TokensTile listed={listed} />
    </section>
  );
}

// ── Cells ────────────────────────────────────────────────────────────────

// A run's second line: its name (the harness title, else the generated one),
// else its task reference, the same fallback the Run page's header reads.
// Turning enrichment off stops Oxagen generating names; it never hides the
// title the harness recorded. A run with neither shows only its id.
function runTitle(run: RunRow): string | null {
  return run.name ?? run.taskRef;
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

/** Which columns right-align their figures. */
const NUMERIC_COLUMNS: ReadonlySet<FleetColumn> = new Set([
  "diff",
  "tokens",
  "cost",
  "frames",
]);

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
  // A paused run is resumed on its Run page, and an export refuses an open
  // run, so its row links there.
  const action =
    state === "live"
      ? "pause"
      : state === "parked"
        ? "resolve"
        : state === "paused"
          ? "open"
          : "export";

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
            <RowStatusBadge run={run} state={state} />
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
            <TokensCell run={run} />
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
        {action === "resolve" || action === "open" ? (
          <SafeLink
            to={to}
            data-testid={`row-${action}`}
            data-touch-target=""
            aria-label={t("rowAction", { action: t(action), run: run.id })}
            className={`${buttonSecondary} px-2.5 py-1 text-xs`}
          >
            {t(action)}
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
  | "ledgerRevoked"
  | "roleReason";

/**
 * Why a live run cannot take a command from its row, or null when it can, in
 * the Run page's order (run-controls.tsx). The enforcement tier plays no part
 * (ADR-163): a wrapped row's `commandBlock` says whether the run's host can
 * collect a command. A ledger run has no host. Its controls act on its
 * evidence ingress, and a cancel revokes that ingress for good (#3665).
 */
function pauseRefusal(run: RunRow, canCommand: boolean): PauseRefusal | null {
  if (run.source !== "ledger") {
    const block = commandBlockOf(run);
    if (block !== null) return `blocked.${COMMAND_BLOCK_COPY[block]}`;
  }
  if (!canCommand) return "roleReason";
  if (run.source === "ledger" && run.ingressRevoked === true)
    return "ledgerRevoked";
  return null;
}

/** The `run.commands` copy of each command a ledger run's dialog sends. */
const LEDGER_COPY = {
  pause: "ledgerPause",
  cancel: "ledgerCancel",
} as const;
type LedgerCommand = keyof typeof LEDGER_COPY;

/**
 * The dialog a live row's Pause opens. A wrapped run takes a pause through
 * its host, and the toast says it was queued. A ledger run offers Pause of
 * its evidence ingress, and Cancel. A ledger row whose ingress is paused
 * reads `paused` and links to its Run page, where Resume is (`rowState`), so
 * this dialog never opens on one. The ledger applies each command at once,
 * so the dialog says what changed and re-reads the page when it closes.
 *
 * The board mounts one dialog per run it opens on (`key`), so nothing one
 * run's dialog showed carries into the next. An answer that arrives after
 * its dialog closed is not drawn: the page is read again instead, so the
 * row shows what the command changed.
 */
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
  /**
   * A wrapped run's pause was queued for its host. The board says so and
   * reads the page again. It does not close the dialog, which may by then
   * show another run.
   */
  onQueued: (run: RunRow) => void;
} & Place) {
  const t = useTranslations("fleet.pause");
  const command = useTranslations("run.commands");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [sending, setSending] = useState<LedgerCommand | null>(null);
  const [pending, startTransition] = useTransition();
  const refusal = run === null ? null : pauseRefusal(run, canCommand);
  const ledger = run?.source === "ledger";
  // The run this dialog shows while it is open, and null once it has closed,
  // so a command's answer can tell whether its dialog is still there.
  const showing = useRef<string | null>(null);
  const runId = run?.id ?? null;
  useEffect(() => {
    showing.current = runId;
    return () => {
      showing.current = null;
    };
  }, [runId]);

  function close() {
    const changed = applied !== null;
    showing.current = null;
    setReason("");
    setFailure(null);
    setApplied(null);
    onClose();
    if (changed) navigate.refresh();
  }

  function send(sent: LedgerCommand) {
    if (run === null || refusal !== null || pending) return;
    setFailure(null);
    setSending(sent);
    startTransition(async () => {
      try {
        const result = await dispatchRunCommand(
          org,
          ws,
          run.id,
          sent,
          reason,
        );
        const open = showing.current === run.id;
        if (!result.ok) setFailure(failureText(result));
        else if (result.value.commandIds.length === 0)
          setFailure(command("noRecipient"));
        else if (!open) {
          // The dialog closed before the answer came. Read the page again,
          // so the row shows what the command changed.
          if (ledger) navigate.refresh();
          else onQueued(run);
        } else if (ledger) {
          setReason("");
          setApplied(command(`${LEDGER_COPY[sent]}.applied`));
        } else {
          setReason("");
          onClose();
          onQueued(run);
        }
      } catch {
        setFailure(failureText(UNANSWERED));
      }
    });
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    send("pause");
  }

  const blocked = refusal !== null || pending;
  const actions = ledger ? (
    applied === null ? (
      <>
        <button
          type="button"
          data-touch-target=""
          data-testid="pause-cancel-run"
          disabled={blocked}
          onClick={() => {
            send("cancel");
          }}
          className={buttonDanger}
        >
          {pending && sending === "cancel"
            ? command("cancel.pending")
            : command("ledgerCancel.confirm")}
        </button>
        <button
          type="submit"
          form={formId}
          data-touch-target=""
          disabled={blocked}
          className={buttonPrimary}
        >
          {pending && sending === "pause"
            ? command("pause.pending")
            : command("ledgerPause.confirm")}
        </button>
      </>
    ) : null
  ) : (
    <button
      type="submit"
      form={formId}
      data-touch-target=""
      disabled={blocked}
      className={buttonPrimary}
    >
      {pending ? t("pending") : t("confirm")}
    </button>
  );

  return (
    <SheetDialog
      open={run !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={ledger ? t("ledgerTitle") : t("title")}
      // A ledger dialog carries its own Cancel, so the dismiss button keeps
      // the name Close.
      closeLabel={ledger ? undefined : t("cancel")}
      headerClose={!ledger}
      testId="pause-dialog"
      footerNote={
        ledger
          ? undefined
          : t.rich("footer", {
              mono: (chunks) => <span className={mono}>{chunks}</span>,
            })
      }
      footer={actions}
    >
      {run === null ? null : applied !== null ? (
        <p
          role="status"
          data-testid="ledger-applied"
          className="text-[12.5px] text-muted-foreground"
        >
          {applied}
        </p>
      ) : (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
          {ledger ? (
            <>
              <p className="text-[12.5px] text-muted-foreground">
                {command("ledgerPause.body")}
              </p>
              <p className="text-[12.5px] text-muted-foreground">
                {command("ledgerCancel.body")}
              </p>
            </>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">{t("body")}</p>
          )}
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
            {ledger ? null : (
              <>
                <dt className="text-dim">{t("recordedAs")}</dt>
                <dd>
                  {t.rich("recordedValue", {
                    mono: (chunks) => <span className={mono}>{chunks}</span>,
                  })}
                </dd>
              </>
            )}
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
            {ledger ? command("reasonLabel") : t("reason")}
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
          <p className="text-xs text-muted-foreground">
            {ledger ? command("ledgerReasonHelp") : t("note")}
          </p>
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
  interjections,
  agentTotal,
  liveRuns = null,
  now,
  canCommand,
  prefs: savedPrefs = DEFAULT_FLEET_PREFS,
  pullRequests = "any",
  pullRequestsUnread = false,
  list: askedList,
  total,
  totalBound,
  org,
  ws,
}: {
  runs: RunRow[];
  nextCursor: string | null;
  cursor: string | null;
  approvals: Read<ApprovalQueue>;
  /** The open questions agents paused to ask, which the waiting tile adds to the approvals. */
  interjections: Read<InterjectionQueue>;
  /** Identities in the workspace; null when the agents read failed. */
  agentTotal: number | null;
  /** The workspace's live runs (`list_runs`' `liveRuns`); null when not counted. */
  liveRuns?: number | null;
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
  /** The search, facets, order and page the URL asked for (#3837). */
  list: FleetListQuery;
  /** The runs that match, across the workspace; null past `totalBound`; absent when not counted. */
  total?: number | null;
  totalBound?: number;
} & Place) {
  const t = useTranslations("fleet.runs");
  const pauseT = useTranslations("fleet.pause");
  const tokensWhyId = useId();
  const navigate = useNavigate();
  const failureText = useActionFailure();
  const [chip, setChip] = useState<RunChip>("all");
  // What the read served: a pull-request filter pages newest first.
  const list = effectiveListQuery(askedList, pullRequests);
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

  /** Read the list again with a new query: a navigation to its URL. */
  function readList(next: FleetListQuery, filter = pullRequests) {
    startReading(() => {
      navigate.push(
        routes.fleet(
          org,
          ws,
          listQueryToRoute(effectiveListQuery(next, filter), filter),
        ),
      );
    });
  }

  /** Apply a choice now and remember it in this browser for a year. */
  function save(next: FleetPrefs) {
    setPrefs(next);
    document.cookie = fleetPrefsCookieString(
      next,
      document.URL.startsWith("https:"),
    );
  }

  // The page size is the read's limit, so a new size reads page 1 again:
  // the page re-renders on the server with the saved cookie.
  function changePageSize(size: PageSize) {
    if (size === prefs.pageSize) return;
    save({ ...prefs, pageSize: size });
    if (cursor === null && list.page === 1)
      startReading(() => {
        navigate.refresh();
      });
    else readList(withList(list, {}));
  }

  // The filter is the read's filter and lives in the URL, so a filtered
  // Fleet can be linked, and a new filter starts from page 1.
  function changeFilter(next: PullRequestFilter) {
    if (next === pullRequests) return;
    readList(withList(list, {}), next);
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
      {/* A live wrapped run's stale light is as of this read. With no stream
          to say the host went quiet, Fleet reads itself again once per host
          poll window while it lists one (A-02). */}
      <LiveRefresh
        active={runs.some(canGoStale)}
        intervalMs={STALE_REREAD_MS}
      />
      <Tiles
        listed={listed}
        approvals={approvals}
        interjections={interjections}
        agentTotal={agentTotal}
        liveRuns={liveRuns}
        now={now}
      />
      <section aria-labelledby="fleet-runs" className={panel}>
        <div className={panelHeader}>
          <h2 id="fleet-runs" className={panelTitle}>
            {t("title")}
          </h2>
          <Chips chip={chip} onChip={setChip} />
        </div>
        <RunsListBar
          list={list}
          onList={(next) => {
            readList(next);
          }}
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
                  const label = t(`columns.${key}`);
                  const align = NUMERIC_COLUMNS.has(key)
                    ? "text-right"
                    : "text-left";
                  // The read orders by these columns across the workspace.
                  // The others have no single order in both stores, so they
                  // do not sort. Under a pull-request filter the read pages
                  // newest first, so no header sorts.
                  const sortKey =
                    pullRequests === "any" ? SORTABLE_COLUMNS[key] : undefined;
                  if (sortKey === undefined && key !== "tokens")
                    return (
                      <th
                        key={key}
                        scope="col"
                        className={`${headCell} ${align}`}
                      >
                        {label}
                      </th>
                    );
                  // The design's Tokens header sorts. list_runs orders on the
                  // server (#3837), and its sort keys do not include tokens,
                  // so the header is plain text. The reason is on hover and
                  // in the header's description for a screen reader: a
                  // disabled button cannot take focus, so its title reached
                  // no one using a keyboard.
                  if (sortKey === undefined)
                    return (
                      <th
                        key={key}
                        scope="col"
                        data-testid="head-tokens"
                        title={t("tokensUnsorted")}
                        aria-describedby={tokensWhyId}
                        className={`${headCell} ${align}`}
                      >
                        {label}
                      </th>
                    );
                  const sorted = list.sort === sortKey ? list.dir : null;
                  return (
                    <th
                      key={key}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                      className={`${headCell} ${align}`}
                    >
                      <button
                        type="button"
                        aria-label={t("sortBy", { column: label })}
                        onClick={() => {
                          readList(nextSort(list, sortKey));
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
              {listed.length === 0 ? (
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
                listed.map((row) => (
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
                ))
              )}
            </tbody>
          </table>
          <p id={tokensWhyId} className="sr-only">
            {t("tokensUnsorted")}
          </p>
        </div>
        <RunsPager
          list={list}
          pageSize={prefs.pageSize}
          rows={runs.length}
          {...(total === undefined ? {} : { total })}
          {...(totalBound === undefined ? {} : { totalBound })}
          cursor={cursor}
          nextCursor={nextCursor}
          pullRequests={pullRequests}
          org={org}
          ws={ws}
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
      {/* One dialog per run it opens on, so nothing one run's dialog showed
          carries into the next. */}
      <PauseDialog
        key={pausing?.id ?? "none"}
        run={pausing}
        canCommand={canCommand}
        org={org}
        ws={ws}
        onClose={() => {
          setPausing(null);
        }}
        onQueued={(run) => {
          toast(pauseT("queued", { run: run.id }), "approval");
          navigate.refresh();
        }}
      />
    </>
  );
}
