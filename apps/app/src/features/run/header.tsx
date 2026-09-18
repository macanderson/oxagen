// The Run header (ARCHITECTURE.md §1.2 Run row; mockup `pRun`): what this run
// is, who ran it, where it stands, and what it cost, from the one row
// `get_run` returns.
//
// The generated name is the headline when `summarize_run` wrote one, with the
// run id under it; a run with no name is headed by its id, because a
// placeholder headline would read as a title the record does not have. The
// generated summary sits under the identity, labelled, so the model's sentence
// is never mistaken for the recording.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { eyebrow, mono } from "@/ui/control-styles";
import { GeneratedSummary } from "@/ui/generated-summary";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { NoValue } from "./parts";
import { RecordActions } from "./record-actions";
import { RunControls } from "./run-controls";

function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

export function RunHeader({
  run,
  witnessed,
  orgRole,
  wsRole,
  org,
  ws,
}: {
  run: RunRow;
  /** True when this run witnessed another (spec §8.5); #2955 builds its tabs. */
  witnessed: boolean;
  /**
   * The viewer's two roles, because the writes gate on them differently:
   * `dispatch_command` admits an org Owner or Admin or a workspace Owner or
   * Member, `summarize_run` an org Owner, Admin or Member, `export_run` an org
   * Owner or Admin. Each control is drawn disabled for a viewer its handler
   * would refuse.
   */
  orgRole: OrgRole;
  wsRole: WsRole;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run");
  const format = useFormatter();
  const locale = useLocale();
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short" });
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <p className={eyebrow}>{t("eyebrow")}</p>
          <h2
            className={
              run.name === null
                ? `${mono} text-lg font-semibold break-all`
                : "text-xl font-semibold"
            }
          >
            {run.name ?? run.id}
          </h2>
          {run.name === null ? null : (
            <p className={`${mono} text-xs text-muted-foreground break-all`}>
              {run.id}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <StatusBadge status={run.status} />
            {run.replayGrade === null ? null : (
              <ReplayGradeBadge grade={run.replayGrade} />
            )}
            <span className="text-xs text-muted-foreground">
              {t(`source.${run.source}`)}
            </span>
          </div>
          {run.taskRef === null ? null : (
            <p className="text-sm">{run.taskRef}</p>
          )}
          {run.summary === null ? (
            <p className="max-w-prose text-sm text-muted-foreground">
              {t("noSummary")}
            </p>
          ) : (
            <GeneratedSummary summary={run.summary} layout="block" />
          )}
          {witnessed ? (
            <p
              data-testid="run-witnessed"
              className="max-w-prose text-xs text-muted-foreground"
            >
              {t("witnessed")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <AgentCard
            agentKey={run.agentKey}
            notRecorded={t("notRecorded")}
            sub={run.operatorId === null ? t("notRecorded") : run.operatorId}
          />
          <RunControls
            org={org}
            ws={ws}
            runId={run.id}
            status={run.status}
            source={run.source}
            orgRole={orgRole}
            wsRole={wsRole}
          />
          <RecordActions
            org={org}
            ws={ws}
            runId={run.id}
            sealed={run.status !== "live"}
            hasSummary={run.summary !== null}
            orgRole={orgRole}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border border-border px-4 py-3">
        <Figure label={t("figures.cost")}>
          {run.cost === null ? (
            <NoValue />
          ) : (
            <>
              <Money value={run.cost} />
              <span
                className={`${mono} ml-2 text-[11px] text-muted-foreground`}
              >
                {run.cost.basis ?? t("basisNotRecorded")}
              </span>
            </>
          )}
        </Figure>
        <Figure label={t("figures.turns")}>
          {run.turns === null ? <NoValue /> : formatCount(run.turns, locale)}
        </Figure>
        <Figure label={t("figures.steps")}>
          {formatCount(run.steps, locale)}
        </Figure>
        <Figure label={t("figures.frames")}>
          {formatCount(run.frames, locale)}
        </Figure>
        <Figure label={t("figures.started")}>
          <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
        </Figure>
        <Figure label={t("figures.sealed")}>
          {run.sealedAt === null ? (
            <NoValue />
          ) : (
            <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time>
          )}
        </Figure>
      </div>
    </header>
  );
}
