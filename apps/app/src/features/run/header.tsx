// The Run page's header (mockup `pRun`, spec pages/run.md): who ran it and
// under what tier, the rig it ran on, where it ran, when, and the controls the
// run's status allows. The run id is the page's h1, drawn by page.tsx.
//
// Every chip shows what the record holds. A fact the record does not capture
// (a harness version the session did not report, the effort setting, the
// checkout path) is said to be missing in words rather than left blank or
// guessed, and the model-fit reading the mockup draws is left out because
// nothing records it.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunOutputNode } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { OperatorName } from "@/ui/operator";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { CopyText } from "./copy-text";
import { EnrichmentSwitch } from "./enrichment-switch";
import { RecordActions } from "./record-actions";
import { RunControls } from "./run-controls";

const chip = `${mono} inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-0.5 text-[11.5px]`;
const missing = "text-[11.5px] text-muted-foreground";

/** One labelled row of chips: the rig or the checkout. */
function Strip({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
    >
      <span className="w-16 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The harness the agent registry names, read by the agent's slug. A run whose
 * agent the registry cannot return (no key, a key from another workspace, a
 * denied read) says the harness is not recorded rather than guessing one from
 * the store the run came from.
 */
function harnessOf(agent: Read<AgentDetail> | null) {
  return agent?.ok === true ? agent.value.identity.harness : null;
}

/**
 * The harness name, the key its mark is drawn by, and its version. What the
 * wrapped session recorded wins over the registry, which names the harness an
 * agent was registered with but never a version.
 */
function useHarness(run: RunRow, agent: Read<AgentDetail> | null) {
  const ta = useTranslations("agents");
  const registered = harnessOf(agent);
  if (run.harness) {
    return {
      name: run.harness.name,
      mark: run.harness.runtime ?? registered,
      version: run.harness.version,
    };
  }
  if (registered === null) return null;
  return {
    name: ta(`harness.${registered}`),
    mark: registered,
    version: null,
  };
}

function Rig({ run, agent }: { run: RunRow; agent: Read<AgentDetail> | null }) {
  const t = useTranslations("run.header");
  const harness = useHarness(run, agent);
  const model = run.model;
  return (
    <Strip label={t("rig")} testId="run-rig">
      {harness === null ? (
        <span className={missing}>{t("harnessNotRecorded")}</span>
      ) : (
        <span className={chip}>
          <HarnessIcon harness={harness.mark} size={14} />
          {harness.name}
          <span className="text-muted-foreground">
            {harness.version === null
              ? t("versionNotCaptured")
              : t("harnessVersion", { version: harness.version })}
          </span>
        </span>
      )}
      {model === null ? (
        <span className={missing}>{t("modelNotRecorded")}</span>
      ) : (
        <span
          className={chip}
          title={[model.provider, model.tier]
            .filter((part): part is string => part !== null)
            .join(" ")}
        >
          {model.slug}
        </span>
      )}
      <span className={missing}>{t("effortNotCaptured")}</span>
    </Strip>
  );
}

function joinFacts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * Where the host facts came from. A session observation and the enrollment
 * record keep separate labels, so an old enrollment is never read as what the
 * session saw.
 */
function MachineProvenance({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const machine = run.machine;
  if (machine === null) {
    return run.source === "ledger" ? (
      <p className="text-xs text-muted-foreground">{t("noMachineOnLedger")}</p>
    ) : null;
  }
  const recorded = machine.recorded;
  return (
    <p
      data-testid="run-machine"
      className="flex flex-col text-xs text-muted-foreground"
    >
      <span>
        {recorded === undefined
          ? t("machineNotRecorded")
          : t("machineRecorded", {
              facts: joinFacts([
                recorded.platform,
                recorded.osVersion,
                recorded.arch,
              ]),
            })}
      </span>
      <span>
        {t("machineEnrollment", {
          facts: joinFacts([
            machine.platform,
            machine.osVersion,
            machine.arch,
            machine.nodeVersion,
          ]),
        })}
      </span>
    </p>
  );
}

function Checkout({
  run,
  pulls,
}: {
  run: RunRow;
  /** The pull requests the outputs recorded; null when the outputs read failed. */
  pulls: readonly RunOutputNode[] | null;
}) {
  const t = useTranslations("run.header");
  return (
    <Strip label={t("checkout")} testId="run-checkout">
      <span className={missing}>{t("repoNotCaptured")}</span>
      {pulls === null ? null : pulls.length === 0 ? (
        <span className={missing}>{t("noPullRequest")}</span>
      ) : (
        pulls.map((pull) => (
          <span key={`${pull.seq ?? ""}${pull.name}`} className={chip}>
            {pull.name}
            {pull.where === null ? null : (
              <span className="text-muted-foreground">{pull.where}</span>
            )}
          </span>
        ))
      )}
      {run.machine === null ? (
        <span className={missing}>{t("noMachine")}</span>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <CopyText text={run.machine.hostname} />
          <span className={missing}>{t("pathNotCaptured")}</span>
          <Badge tone="quiet" dot={false}>
            {t("derived")}
          </Badge>
        </span>
      )}
    </Strip>
  );
}

/** "<task> · started <t> by <operator> · sealed <t>". */
function When({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const tr = useTranslations("run");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short" });
  // A run with no operator on record says so, rather than dropping "by".
  const operator =
    run.operatorId === null && run.operatorName === null ? (
      tr("notRecorded")
    ) : (
      <OperatorName
        testId="run-operator-name"
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
            tr(`facts.operatorKind.${run.operatorKind}`)
          ))}
      </OperatorName>
    );
  const title =
    (run.enrichmentEnabled === false ? null : run.name) ?? run.taskRef;
  return (
    <p
      data-testid="run-when"
      className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground"
    >
      {title === null ? null : (
        <>
          <span className="font-medium text-foreground">{title}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>
        {t("started")}{" "}
        <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
      </span>
      <span data-testid="run-operator">
        {t("by")} {operator}
      </span>
      <span aria-hidden="true">·</span>
      {run.sealedAt === null ? (
        <span>{t("running")}</span>
      ) : (
        <span>
          {t("sealed")}{" "}
          <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time>
        </span>
      )}
    </p>
  );
}

export function RunHeader({
  run,
  agent,
  pulls,
  orgRole,
  wsRole,
  org,
  ws,
}: {
  run: RunRow;
  /** `get_agent` for the run's agent; null when the run names no agent. */
  agent: Read<AgentDetail> | null;
  pulls: readonly RunOutputNode[] | null;
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
  const harness = useHarness(run, agent);
  return (
    <header data-testid="run-header" className="flex flex-col gap-3">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div
            data-testid="run-chips"
            aria-label={t("header.chips")}
            className="flex flex-wrap items-center gap-x-3 gap-y-2"
          >
            <AgentCard
              agentKey={run.agentKey}
              notRecorded={t("notRecorded")}
              sub={
                harness === null ? t("header.harnessNotRecorded") : harness.name
              }
            />
            <StatusBadge status={run.status} outcome={run.outcome} />
            <EnforcementTierBadge
              tier={run.enforcementTier}
              testId="run-tier"
            />
            {run.replayGrade === null ? null : (
              <ReplayGradeBadge grade={run.replayGrade} />
            )}
            {run.taskRef === null ? null : (
              <span data-testid="run-task" className={chip}>
                {run.taskRef}
              </span>
            )}
          </div>
          <Rig run={run} agent={agent} />
          <Checkout run={run} pulls={pulls} />
          <MachineProvenance run={run} />
          <When run={run} />
          <p className="text-xs text-muted-foreground">
            {t(`source.${run.source}`)}
          </p>
          {run.completenessGaps.length === 0 ? null : (
            <p
              data-testid="run-gaps"
              className="max-w-prose text-xs text-muted-foreground"
            >
              {t("gaps")}{" "}
              {run.completenessGaps.map((gap) => t(`gap.${gap}`)).join(", ")}
            </p>
          )}
          <EnrichmentSwitch
            org={org}
            ws={ws}
            enabled={run.enrichmentEnabled !== false}
            canEdit={
              ["owner", "admin"].includes(orgRole) ||
              ["owner", "admin"].includes(wsRole)
            }
          />
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
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
      {run.ingressPaused === true ? (
        <p
          role="status"
          data-testid="run-paused"
          className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground"
        >
          {t("header.paused")}
        </p>
      ) : null}
    </header>
  );
}
