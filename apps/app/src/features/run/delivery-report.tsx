"use client";
// The delivery report (#2953; mockup `deliveryreport`, pages/run.md): every
// command sent to a run, or every command one broadcast queued, and how far
// each one got. `applied` is the only success, and it names the frame that
// proves it (spec §7.4); `cancelled`, `expired` and `failed` count as
// undelivered. The mode a person asked for and the mode the connection point
// carried are two facts, never one (INV-10), so a steer that was asked to
// interrupt and landed at the next model call says both.
//
// The report is read when the dialog opens (`readDeliveryReport`), so a
// report nobody opens costs no read, and each opening reads it again.
//
// A broadcast's steer to an idle agent is held for that agent's next run, so
// its row names the agent in place of a run until the run opens.
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { CommandReport, DeliveryMode } from "@/data/contracts/runs";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  kvList,
  kvTerm,
  kvValue,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type ReportQuery, readDeliveryReport } from "./actions";
import {
  DELIVERY_COPY,
  degradedOf,
  type ReportCommand,
  STATUS_TALLY,
  STATUS_TONE,
  TALLIES,
  type Tally,
} from "./command-report";

type State =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "read"; report: CommandReport }
  | { kind: "failed"; text: string };

/** The facts of one command, each a fact the record holds. */
function CommandRow({
  command,
  org,
  ws,
  onOpenFrame,
}: {
  command: ReportCommand;
  org: string;
  ws: string;
  /** Closes the dialog when a frame link is followed. */
  onOpenFrame: () => void;
}) {
  const t = useTranslations("run.report");
  const modes = useTranslations("run.commands.delivery");
  const format = useFormatter();
  const mode = (value: DeliveryMode) =>
    modes(`${DELIVERY_COPY[value]}.label`);
  const issuer = command.issuedBy;
  const degraded =
    command.degradedReason === null
      ? null
      : degradedOf(command.degradedReason);
  return (
    <li
      data-testid="report-command"
      data-status={command.status}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className={`${mono} font-semibold`}>
          {t("command", { command: command.command })}
        </span>
        <Badge tone={STATUS_TONE[command.status]}>
          {t(`status.${command.status}`)}
        </Badge>
        <span className={`${mono} break-all text-xs text-muted-foreground`}>
          {command.runId ?? command.agentKey}
        </span>
      </p>
      {command.runId === null ? (
        <p data-testid="report-held" className="text-sm text-muted-foreground">
          {t("heldForNextRun")}
        </p>
      ) : null}
      <dl className={kvList}>
        <dt className={kvTerm}>{t("requested")}</dt>
        <dd data-testid="report-requested" className={kvValue}>
          {command.requestedMode === null
            ? t("noMode")
            : mode(command.requestedMode)}
        </dd>
        <dt className={kvTerm}>{t("delivered")}</dt>
        <dd data-testid="report-delivered" className={kvValue}>
          {command.deliveryMode === null
            ? command.requestedMode === null
              ? t("noMode")
              : t("notResolved")
            : mode(command.deliveryMode)}
        </dd>
        {command.degradedReason === null ? null : (
          <>
            <dt className={kvTerm}>{t("downgrade")}</dt>
            <dd className={kvValue}>
              {degraded === null
                ? command.degradedReason
                : t(`degraded.${degraded}`)}
            </dd>
          </>
        )}
        <dt className={kvTerm}>{t("issuedBy")}</dt>
        <dd className={kvValue}>
          {issuer === null ? (
            t("notRecorded")
          ) : issuer.name === null ? (
            <span className={mono}>{issuer.id}</span>
          ) : (
            issuer.name
          )}
        </dd>
        <dt className={kvTerm}>{t("issued")}</dt>
        <dd className={kvValue}>
          <time dateTime={command.issuedAt}>
            {format.dateTime(new Date(command.issuedAt), {
              dateStyle: "medium",
              timeStyle: "medium",
            })}
          </time>
        </dd>
        <dt className={kvTerm}>{t("frame")}</dt>
        <dd data-testid="report-frame" className={kvValue}>
          {command.appliedAtSeq === null || command.runId === null ? (
            t("noFrame")
          ) : (
            <SafeLink
              to={routes.run(org, ws, command.runId, {
                tab: "actions",
                body: String(command.appliedAtSeq),
              })}
              onClick={onOpenFrame}
              className={linkText}
            >
              {t("frameLink", { seq: String(command.appliedAtSeq) })}
            </SafeLink>
          )}
        </dd>
        {command.text === null ? null : (
          <>
            <dt className={kvTerm}>{t("text")}</dt>
            <dd className={kvValue}>
              <q>{command.text}</q>
            </dd>
          </>
        )}
        {command.reason === null ? null : (
          <>
            <dt className={kvTerm}>{t("reason")}</dt>
            <dd className={kvValue}>{command.reason}</dd>
          </>
        )}
        {command.detail === null ? null : (
          <>
            <dt className={kvTerm}>{t("detail")}</dt>
            <dd className={`${kvValue} ${mono}`}>{command.detail}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

function ReportBody({
  state,
  org,
  ws,
  onOpenFrame,
}: {
  state: State;
  org: string;
  ws: string;
  onOpenFrame: () => void;
}) {
  const t = useTranslations("run.report");
  if (state.kind === "idle" || state.kind === "reading")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("reading")}
      </p>
    );
  if (state.kind === "failed")
    return <FormAlert testId="report-failure">{state.text}</FormAlert>;
  const { commands } = state.report;
  if (commands.length === 0)
    return (
      <p data-testid="report-empty" className="text-sm text-muted-foreground">
        {t("empty")}
      </p>
    );
  const counts = new Map<Tally, number>();
  for (const command of commands) {
    const tally = STATUS_TALLY[command.status];
    counts.set(tally, (counts.get(tally) ?? 0) + 1);
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2">
        {TALLIES.map((tally) => (
          <div
            key={tally}
            data-testid={`report-${tally}`}
            className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2"
          >
            <dt className="text-xs text-muted-foreground">{t(tally)}</dt>
            <dd className="m-0 text-lg font-semibold tabular-nums">
              {counts.get(tally) ?? 0}
            </dd>
          </div>
        ))}
      </dl>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {commands.map((command) => (
          <CommandRow
            key={command.id}
            command={command}
            org={org}
            ws={ws}
            onOpenFrame={onOpenFrame}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * The button that opens the report, and the report. `query` names one run's
 * commands or a broadcast's command ids.
 */
export function DeliveryReport({
  org,
  ws,
  query,
  testId = "delivery-report",
}: {
  org: string;
  ws: string;
  query: ReportQuery;
  testId?: string;
}) {
  const t = useTranslations("run.report");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  // Counts the readings, so an answer to one the dialog has since closed or
  // read again does not overwrite the latest.
  const reading = useRef(0);

  async function read() {
    reading.current += 1;
    const mine = reading.current;
    setState({ kind: "reading" });
    let next: State;
    try {
      const result = await readDeliveryReport(org, ws, query);
      // A read changes nothing, so its failure names the code and says to
      // open the report again; the command sentences say nothing was queued.
      next = result.ok
        ? { kind: "read", report: result.value }
        : {
            kind: "failed",
            text: t("failed", {
              code:
                result.reason === "pending_approval"
                  ? result.accessRequestId
                  : result.code,
            }),
          };
    } catch {
      next = { kind: "failed", text: t("unanswered") };
    }
    if (mine === reading.current) setState(next);
  }

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      reading.current += 1;
      setState({ kind: "idle" });
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={`${testId}-open`}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
          void read();
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title")}
        wide
        testId={testId}
      >
        <ReportBody
          state={state}
          org={org}
          ws={ws}
          onOpenFrame={() => {
            openChange(false);
          }}
        />
      </SheetDialog>
    </>
  );
}
