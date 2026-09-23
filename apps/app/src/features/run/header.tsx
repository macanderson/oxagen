// The Run page's header (mockup `pRun`, spec pages/run.md): the eyebrow "Run"
// and the run id as the page's h1, who ran it and under what tier, the rig it
// ran on, where it ran, when, and the controls the run's status allows.
//
// Every chip shows what the record holds. A fact the record does not capture
// (a harness version the session did not report, the effort setting, the
// repository, the branch and the checkout path) is said to be missing in words
// rather than left blank or guessed. The model-fit badges the mockup draws
// beside the rig need a fit reading nothing records (G14), so they are not
// drawn; the Cost tab's Model fit panel names that gap.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunOutputNode } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { eyebrow, mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { CopyText } from "./copy-text";
import { ExportAction } from "./record-actions";
import { ReplayActions } from "./replay-actions";
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
      role="group"
      aria-label={label}
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
    >
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
export function useHarness(run: RunRow, agent: Read<AgentDetail> | null) {
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
        <span className={chip}>
          <span className="text-muted-foreground">
            {t("harnessNotRecorded")}
          </span>
        </span>
      ) : (
        <span className={chip}>
          <HarnessIcon harness={harness.mark} size={14} />
          {harness.name}
          <span className="text-muted-foreground">
            {harness.version === null
              ? t("versionNotCaptured")
              : harness.version}
          </span>
        </span>
      )}
      {model === null ? (
        <span className={chip}>
          <span className="text-muted-foreground">{t("modelNotRecorded")}</span>
        </span>
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
      {/* Effort is read out of the request body, which the record does not
          keep (G6), so the chip says so rather than printing a default. */}
      <span
        data-testid="run-effort"
        data-gap="G6"
        title={t("effortWhy")}
        className={chip}
      >
        {t("effort")}{" "}
        <span className="text-muted-foreground">{t("notCaptured")}</span>
      </span>
    </Strip>
  );
}

function joinFacts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * Where the host facts came from, as the machine chip's tooltip. A session
 * observation and the enrollment record keep separate sentences, so an old
 * enrollment is never read as what the session saw.
 */
function useMachineProvenance(run: RunRow): string | null {
  const t = useTranslations("run.header");
  const machine = run.machine;
  if (machine === null) return null;
  const recorded = machine.recorded;
  return [
    recorded === undefined
      ? t("machineNotRecorded")
      : t("machineRecorded", {
          facts: joinFacts([
            recorded.platform,
            recorded.osVersion,
            recorded.arch,
          ]),
        }),
    t("machineEnrollment", {
      facts: joinFacts([
        machine.platform,
        machine.osVersion,
        machine.arch,
        machine.nodeVersion,
      ]),
    }),
    t("pathWhy"),
  ].join(" ");
}

/**
 * The checkout: the repository, the branch, every pull request the run pushed
 * to, and `<machine>:<path>`. The run record carries the host and the pull
 * requests the outputs recorded; the repository, the branch and the path are
 * not on it, so each says so rather than borrowing a value from another host.
 */
function Checkout({
  run,
  pulls,
}: {
  run: RunRow;
  /** The pull requests the outputs recorded; null when the outputs read failed. */
  pulls: readonly RunOutputNode[] | null;
}) {
  const t = useTranslations("run.header");
  const provenance = useMachineProvenance(run);
  return (
    <Strip label={t("checkout")} testId="run-checkout">
      <span className={chip}>
        <span className="text-muted-foreground">{t("repoNotCaptured")}</span>
      </span>
      <span className={chip}>
        <span className="text-muted-foreground">{t("branchNotCaptured")}</span>
      </span>
      {pulls === null ? null : pulls.length === 0 ? (
        <span className={chip}>
          <span className="text-muted-foreground">{t("noPullRequest")}</span>
        </span>
      ) : (
        pulls.map((pull) => (
          <span
            key={`${pull.seq ?? ""}${pull.name}`}
            data-testid="run-checkout-pr"
            className={chip}
          >
            {pull.name}
          </span>
        ))
      )}
      {run.machine === null ? (
        <span className={chip}>
          <span className="text-muted-foreground">
            {run.source === "ledger" ? t("noMachineOnLedger") : t("noMachine")}
          </span>
        </span>
      ) : (
        <span
          data-testid="run-machine"
          title={provenance ?? undefined}
          className="inline-flex flex-wrap items-center gap-1.5"
        >
          <CopyText text={run.machine.hostname} />
          <span className={missing}>{t("pathNotCaptured")}</span>
        </span>
      )}
    </Strip>
  );
}

/** "<task title> · started <t>", with "· sealed <t>" once sealed. */
function When({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short" });
  const title = run.name ?? run.taskRef;
  return (
    <p
      data-testid="run-when"
      className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground"
    >
      {title === null ? null : (
        <>
          <span className="text-foreground">{title}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>
        {t("started")}{" "}
        <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
      </span>
      {run.sealedAt === null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span>
            {t("sealed")}{" "}
            <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time>
          </span>
        </>
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
   * Member, and `export_run` an org Owner or Admin. Each control is drawn
   * disabled for a viewer its handler would refuse.
   */
  orgRole: OrgRole;
  wsRole: WsRole;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run");
  const tp = useTranslations("pages");
  const harness = useHarness(run, agent);
  // Export is always last. A live run's controls come first; an ended run
  // offers Fork replay and Bisect, which read the finished recording.
  const exportAction = (
    <ExportAction
      org={org}
      ws={ws}
      runId={run.id}
      sealed={run.status !== "live"}
      orgRole={orgRole}
    />
  );
  return (
    <header data-testid="run-header" className="flex flex-col gap-3">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <p className={eyebrow}>{tp("run")}</p>
          <h1 className="break-all font-mono text-[19px] font-bold leading-tight text-foreground">
            {run.id}
          </h1>
          <div
            data-testid="run-chips"
            aria-label={t("header.chips")}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1"
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
                {t("header.task", { ref: run.taskRef })}
              </span>
            )}
          </div>
          <Rig run={run} agent={agent} />
          <Checkout run={run} pulls={pulls} />
          <When run={run} />
        </div>
        <div
          data-testid="run-actions"
          className="flex flex-col gap-3 lg:items-end"
        >
          {run.status === "live" ? (
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
              after={exportAction}
            />
          ) : (
            <ReplayActions org={org} ws={ws} run={run} after={exportAction} />
          )}
        </div>
      </div>
      {run.ingressPaused === true ? (
        <p
          role="status"
          data-testid="run-paused"
          className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground"
        >
          <strong className="font-semibold">{t("header.pausedTitle")}</strong>{" "}
          {t("header.paused")}
        </p>
      ) : null}
    </header>
  );
}
