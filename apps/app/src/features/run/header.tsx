import { useLocale, useTranslations } from "next-intl";
import type { RunMachine, RunModel, RunRow } from "@/data/contracts/runs";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import {
  eyebrow,
  mono,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { StatusBadge } from "@/ui/status-badge";
import { OperatorName } from "@/ui/operator";
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
  // The id is never the label and never a line under it: it lives in the
  // operator's hover card, copyable, with the rest of who they are.
  if (run.operatorId === null && run.operatorName === null) {
    return {
      value:
        run.operatorKind === null ? <NoValue /> : kindLabel(run.operatorKind),
    };
  }
  return {
    value: (
      <OperatorName
        operator={{
          id: run.operatorId,
          name: run.operatorName,
          kind: run.operatorKind,
        }}
      >
        {run.operatorName ??
          (run.operatorKind === null ? (
            // An id with no name and no kind is still a recorded operator:
            // the id is the label, never "not recorded".
            <span className={mono}>{run.operatorId}</span>
          ) : (
            kindLabel(run.operatorKind)
          ))}
      </OperatorName>
    ),
  };
}

/**
 * One figure of the run, drawn as the house stat tile (`.stat`, engine.css)
 * so the Run page's strip reads like the Fleet page's: the label in caps
 * over a large tabular figure. A row of small labelled numbers in one bordered
 * box was the same six facts at a third of the weight, and the cost, which is
 * the figure a person opens a run for, read no larger than its frame count.
 */
function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={statTile}>
      <span className={statTerm}>{label}</span>
      <span className={`${statValue} min-w-0 truncate`}>{children}</span>
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
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <AgentCard
            agentKey={run.agentKey}
            notRecorded={t("notRecorded")}
            sub={
              run.operatorId === null && run.operatorName === null ? (
                t("notRecorded")
              ) : (
                <OperatorName
                  testId="run-agent-operator"
                  operator={{
                    id: run.operatorId,
                    name: run.operatorName,
                    kind: run.operatorKind,
                  }}
                >
                  {run.operatorName ??
                    (run.operatorKind === null ? (
                      <span className={mono}>{run.operatorId}</span>
                    ) : (
                      t(`facts.operatorKind.${run.operatorKind}`)
                    ))}
                </OperatorName>
              )
            }
          />
          <RunControls
            org={org}
            ws={ws}
            runId={run.id}
            status={run.status}
            source={run.source}
            enforcementTier={run.enforcementTier}
            ingressRevoked={run.ingressRevoked}
            ingressPaused={run.ingressPaused}
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
      <div data-testid="run-figures" className={statStrip}>
        <Figure label={t("figures.cost")}>
          {run.cost === null ? (
            <NoValue />
          ) : (
            <>
              <Money value={run.cost} />
              <span
                className={`${mono} ml-2 text-[11px] font-normal tracking-normal text-muted-foreground`}
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
