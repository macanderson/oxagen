import { useLocale, useTranslations } from "next-intl";
import type { RunMachine, RunModel, RunRow } from "@/data/contracts/runs";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { eyebrow, mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { GeneratedSummary } from "@/ui/generated-summary";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { StatusBadge } from "@/ui/status-badge";
import { NoValue } from "./parts";
import { RecordActions } from "./record-actions";
import { RunControls } from "./run-controls";
import { useFormatter } from "@/ui/formatter";

/**
 * A named fact about the run that is a word rather than a number, with the
 * detail it carries set under it. It is deliberately not a {@link Figure}: the
 * figures row is tabular numerals, and a hostname rendered in them reads as a
 * measurement.
 */
function Fact({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  /** The qualifier under the value; left out when nothing qualifies it. */
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-medium">{value}</span>
      {detail === undefined ? null : (
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      )}
    </div>
  );
}

/**
 * The model id as the record holds it, with the vendor that served it and the
 * capability class it belongs to under it. A half the record could not name is
 * left out rather than filled: `anthropic` alone is the whole qualifier when
 * the id names no class.
 */
function ModelFact({ label, model }: { label: string; model: RunModel }) {
  const parts = [model.provider, model.tier].filter(
    (part): part is string => part !== null,
  );
  return (
    <Fact
      label={label}
      value={<span className={`${mono} break-all`}>{model.slug}</span>}
      detail={parts.length === 0 ? undefined : parts.join(" · ")}
    />
  );
}

/** Session observations and enrollment facts keep their source labels. */
function MachineFact({
  label,
  machine,
}: {
  label: string;
  machine: RunMachine;
}) {
  const t = useTranslations("run.facts");
  const enrollment = [
    machine.platform,
    machine.osVersion,
    machine.arch,
    machine.nodeVersion,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const recorded = machine.recorded;
  const runtime =
    recorded === undefined
      ? undefined
      : [recorded.platform, recorded.osVersion, recorded.arch]
          .filter((part): part is string => part !== null)
          .join(" · ");
  return (
    <Fact
      label={label}
      value={<span className={`${mono} break-all`}>{machine.hostname}</span>}
      detail={
        <>
          {runtime === undefined ? (
            <span className="block">{t("machineNotRecorded")}</span>
          ) : (
            <span className="block">
              {t("machineRecorded", { facts: runtime })}
            </span>
          )}
          <span className="block">
            {t("machineEnrollment", { facts: enrollment })}
          </span>
        </>
      }
    />
  );
}

/**
 * Who ran the run, and the honest reason when there is no name to print.
 *
 * A name is only ever the person's own, so a run started by an agent or a
 * service says so instead of borrowing the name of whoever created it. A
 * person the record holds no name for is named as a person without one, which
 * is a different fact from "not recorded" and reads as one. The principal id
 * stays under whichever of those the row carries, because it is the identifier
 * the rest of the record is keyed on.
 */
function operatorFact(
  run: RunRow,
  kindLabel: (kind: NonNullable<RunRow["operatorKind"]>) => string,
): { value: React.ReactNode; detail?: React.ReactNode } {
  const detail =
    run.operatorId === null ? undefined : (
      <span className={`${mono} break-all`}>{run.operatorId}</span>
    );
  if (run.operatorName !== null) return { value: run.operatorName, detail };
  if (run.operatorKind === null) return { value: <NoValue />, detail };
  return { value: kindLabel(run.operatorKind), detail };
}

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
  orgRole,
  wsRole,
  org,
  ws,
}: {
  run: RunRow;
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
  const operator = operatorFact(run, (kind) => t(`facts.operatorKind.${kind}`));
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <p className={eyebrow}>{t("eyebrow")}</p>
          <h2 className="text-xl font-semibold">
            {run.name ?? run.taskRef ?? t("unnamedRun")}
          </h2>
          <p className={`${mono} text-xs text-muted-foreground break-all`}>
            {run.id}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <StatusBadge status={run.status} outcome={run.outcome} />
            <EnforcementTierBadge
              tier={run.enforcementTier}
              testId="run-tier"
            />
            <span className="text-xs text-muted-foreground">
              {t(`source.${run.source}`)}
            </span>
          </div>
          {run.completenessGaps.length === 0 ? null : (
            <p
              data-testid="run-gaps"
              className="max-w-prose text-xs text-muted-foreground"
            >
              {t("gaps")}{" "}
              {run.completenessGaps.map((gap) => t(`gap.${gap}`)).join(", ")}
            </p>
          )}
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
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <AgentCard
            agentKey={run.agentKey}
            notRecorded={t("notRecorded")}
            sub={run.operatorName ?? run.operatorId ?? t("notRecorded")}
          />
          <RunControls
            org={org}
            ws={ws}
            runId={run.id}
            status={run.status}
            source={run.source}
            enforcementTier={run.enforcementTier}
            orgRole={orgRole}
            wsRole={wsRole}
          />
          <RecordActions
            org={org}
            ws={ws}
            runId={run.id}
            sealed={run.status !== "live"}
            hasSummary={run.summary !== null}
            summarizable={run.canSummarize}
            orgRole={orgRole}
          />
        </div>
      </div>
      <div
        data-testid="run-facts"
        className="grid gap-x-8 gap-y-3 rounded-lg border border-border px-4 py-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <Fact
          label={t("facts.operator")}
          value={operator.value}
          detail={operator.detail}
        />
        {run.model === null ? (
          <Fact label={t("facts.model")} value={<NoValue />} />
        ) : (
          <ModelFact label={t("facts.model")} model={run.model} />
        )}
        {run.machine === null ? (
          <Fact
            label={t("facts.machine")}
            value={<NoValue />}
            detail={
              run.source === "ledger" ? t("facts.noMachineOnLedger") : undefined
            }
          />
        ) : (
          <MachineFact label={t("facts.machine")} machine={run.machine} />
        )}
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
