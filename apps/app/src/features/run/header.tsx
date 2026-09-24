// The Run page's header (mockup `pRun`, spec pages/run.md): the eyebrow "Run"
// and the run id as the page's h1, who ran it and under what tier, the rig it
// ran on, where it ran, when, and the controls the run's status allows.
//
// Every chip shows what the record holds. The rig reads the session row (the
// model, the effort level and thinking setting the harness reported, and the
// permission mode), and the checkout reads `get_run_work` (the worktree
// frames). A run whose session started subagents lists them in a third strip
// from the same read, one chip per recorded agent id. A fact the record does
// not capture (a harness version the session did not report, an effort
// setting no frame carried, the repository, the branch and the checkout path)
// is said to be missing in words rather than left blank or guessed. The
// model-fit badges the mockup draws beside the rig need a fit reading nothing
// records (G14), so they are not drawn; the Cost tab's Model fit panel names
// that gap.
import { useLocale, useTranslations } from "next-intl";
import { Suspense } from "react";
import type { Cost } from "@/data/contracts/money";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunOutputNode } from "@/data/contracts/run";
import type { RunSubagent, RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { Badge } from "@/ui/badge";
import { eyebrow, mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { CopyText } from "./copy-text";
import {
  branchUrl,
  checkoutOf,
  ForgeLink,
  pullForBranch,
  pullName,
  repositoriesOf,
  usePullState,
  WithWork,
  workOf,
} from "./work-ci";
import { ExportAction } from "./record-actions";
import { ReplayActions } from "./replay-actions";
import { PauseBannerActions, RunControls } from "./run-controls";

const chip = `${mono} inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-0.5 text-[11.5px]`;
const missing = "text-[11.5px] text-muted-foreground";

/** Subagent chips drawn before the rest are counted as "N more". */
const SUBAGENT_CHIPS = 12;

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
      {/* The effort level is the one the harness reported in its config
          frame. A session whose frames carried none says so rather than
          printing a default, because the request body that would carry it is
          not kept (G6). */}
      {run.effort == null ? (
        <span
          data-testid="run-effort"
          data-gap="G6"
          title={t("effortWhy")}
          className={chip}
        >
          {t("effort")}{" "}
          <span className="text-muted-foreground">{t("notCaptured")}</span>
        </span>
      ) : (
        <span data-testid="run-effort" className={chip}>
          {t("effortValue", { value: run.effort })}
        </span>
      )}
      {run.thinking == null ? null : (
        <span data-testid="run-thinking" className={chip}>
          {run.thinking ? t("thinkingOn") : t("thinkingOff")}
        </span>
      )}
      {run.permissionMode == null ? (
        <span data-testid="run-permission-mode" className={chip}>
          <span className="text-muted-foreground">
            {t("permissionModeNotRecorded")}
          </span>
        </span>
      ) : (
        <span data-testid="run-permission-mode" className={chip}>
          {t("permissionMode", { value: run.permissionMode })}
        </span>
      )}
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
 * The output PR nodes the work read did not already answer. Both reads carry
 * a harness PR link, so the same PR would otherwise be drawn twice. The work
 * read wins, since it carries the PR's state from the forge.
 */
function pullsBeyond(
  pulls: readonly RunOutputNode[] | null,
  recorded: RunWork["pullRequests"],
): RunOutputNode[] {
  const drawn = new Set(
    recorded.map((pr) =>
      `${pr.repository.owner}/${pr.repository.name}#${String(pr.number)}`.toLowerCase(),
    ),
  );
  return (pulls ?? []).filter(
    (node) => !drawn.has(`${node.where ?? ""}${node.name}`.toLowerCase()),
  );
}

/** The pull requests the outputs recorded, as plain chips. */
function OutputPulls({ pulls }: { pulls: readonly RunOutputNode[] }) {
  return pulls.map((pull) => (
    <span
      key={`${pull.seq ?? ""}${pull.name}`}
      data-testid="run-checkout-pr"
      className={chip}
    >
      {pull.name}
    </span>
  ));
}

/**
 * The checkout: the repository, the branch, every pull request the run pushed
 * to, and `<machine>:<path>`. `get_run_work` carries what the collector
 * recorded (the checkout's repository, branch and path, and the pull requests
 * that name its commits); until it answers, or when it fails, the strip draws
 * what the run record alone carries and says the rest was not captured,
 * rather than borrowing a value from another host.
 *
 * Every path shown here is one the collector recorded on the run's own host,
 * so none is marked `derived`: Oxagen does not work a path out.
 */
function Checkout({
  run,
  pulls,
  work,
}: {
  run: RunRow;
  /** The pull requests the outputs recorded; null when the outputs read failed. */
  pulls: readonly RunOutputNode[] | null;
  /** The settled work read; null while it is on its way. */
  work: Read<RunWork> | null;
}) {
  const t = useTranslations("run.header");
  const stateOf = usePullState();
  const provenance = useMachineProvenance(run);
  const evidence = workOf(work);
  const checkout = checkoutOf(evidence);
  const repository =
    checkout?.repository ?? repositoriesOf(evidence)[0] ?? null;
  const branch = checkout?.branch ?? null;
  const headed = pullForBranch(evidence, branch);
  const forgePulls = evidence?.pullRequests ?? [];
  const extraPulls =
    forgePulls.length === 0 ? [] : pullsBeyond(pulls, forgePulls);
  const others = Math.max((evidence?.checkouts.length ?? 0) - 1, 0);
  const machine = evidence?.machine?.name ?? run.machine?.hostname ?? null;
  return (
    <Strip label={t("checkout")} testId="run-checkout">
      {repository === null ? (
        <span className={chip}>
          <span className="text-muted-foreground">{t("repoNotCaptured")}</span>
        </span>
      ) : (
        <ForgeLink
          url={repository.url}
          className={`${chip} font-semibold hover:border-foreground`}
        >
          <span data-testid="run-checkout-repo">
            {repository.owner}/{repository.name}
          </span>
        </ForgeLink>
      )}
      {branch === null ? (
        <span className={chip}>
          <span className="text-muted-foreground">
            {t("branchNotCaptured")}
          </span>
        </span>
      ) : (
        <ForgeLink
          url={branchUrl(repository, branch, headed)}
          className={`${chip} hover:border-foreground`}
        >
          <span data-testid="run-checkout-branch">{branch}</span>
        </ForgeLink>
      )}
      {forgePulls.length > 0 ? (
        <>
          {forgePulls.map((pull) => (
            <ForgeLink
              key={pull.url}
              url={pull.url}
              className={`${chip} hover:border-foreground`}
            >
              <span data-testid="run-checkout-pr">{pullName(pull)}</span>
              <span className="text-muted-foreground">{stateOf(pull)}</span>
            </ForgeLink>
          ))}
          <OutputPulls pulls={extraPulls} />
        </>
      ) : pulls === null ? null : pulls.length === 0 ? (
        <span className={chip}>
          <span className="text-muted-foreground">{t("noPullRequest")}</span>
        </span>
      ) : (
        <OutputPulls pulls={pulls} />
      )}
      {machine === null ? (
        <span className={chip}>
          <span className="text-muted-foreground">
            {run.source === "ledger" ? t("noMachineOnLedger") : t("noMachine")}
          </span>
        </span>
      ) : checkout === null ? (
        <span
          data-testid="run-machine"
          title={provenance ?? undefined}
          className="inline-flex flex-wrap items-center gap-1.5"
        >
          <CopyText text={machine} />
          <span className={missing}>{t("pathNotCaptured")}</span>
        </span>
      ) : (
        <span
          data-testid="run-machine"
          title={t("pathRecorded", {
            from: checkout.firstSeq,
            to: checkout.lastSeq,
          })}
          className="inline-flex flex-wrap items-center gap-1.5"
        >
          <CopyText text={`${machine}:${checkout.path}`} />
        </span>
      )}
      {others === 0 ? null : (
        <span data-testid="run-more-checkouts" className={missing}>
          {t("moreCheckouts", { count: others })}
        </span>
      )}
    </Strip>
  );
}

function SubagentChip({
  subagent,
  live,
}: {
  subagent: RunSubagent;
  live: boolean;
}) {
  const t = useTranslations("run.header");
  return (
    <span data-testid="run-subagent" className={chip} title={subagent.id}>
      {subagent.type ?? (
        <span className="text-muted-foreground">
          {t("subagentTypeNotRecorded")}
        </span>
      )}
      <span className="text-muted-foreground">{subagent.id.slice(0, 7)}</span>
      {subagent.stopped ? null : (
        <span className="text-muted-foreground">
          {live ? t("subagentRunning") : t("subagentNoStop")}
        </span>
      )}
    </span>
  );
}

/**
 * The subagents the session started, one chip per recorded agent id, from the
 * subagent hook frames `get_run_work` reads. The strip is drawn only for a
 * session that started one, so a run without subagents keeps the two strips
 * the spec draws. A chip reads live from the run's status, the same
 * definition of sealed the rest of the header uses.
 */
function Subagents({ run, work }: { run: RunRow; work: Read<RunWork> }) {
  const t = useTranslations("run.header");
  const subagents = workOf(work)?.subagents ?? [];
  if (subagents.length === 0) return null;
  return (
    <Strip label={t("subagents")} testId="run-subagents">
      {subagents.slice(0, SUBAGENT_CHIPS).map((subagent) => (
        <SubagentChip
          key={subagent.id}
          subagent={subagent}
          live={run.status === "live"}
        />
      ))}
      {subagents.length > SUBAGENT_CHIPS ? (
        <span className={missing}>
          {t("moreSubagents", { count: subagents.length - SUBAGENT_CHIPS })}
        </span>
      ) : null}
    </Strip>
  );
}

/**
 * "<task title> · started <t>", then, once the run ended, "· ended <t>" by
 * the recorder's clock and "· sealed <t>" by the server's receipt. Keyed on
 * the run's status, the one definition of sealed the header's actions use, so
 * an ended run with no seal instant says so rather than reading as running.
 */
function When({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short" });
  // The run's name is the title its harness recorded, else the one Oxagen
  // generated, then the task reference. Turning automatic names off stops
  // Oxagen generating one (ADR-153); the server never answers a generated
  // name then, and it never hides the title the harness recorded.
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
      {run.status === "live" ? null : (
        <>
          {run.endedAt == null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="run-ended">
                {t("ended")}{" "}
                <time dateTime={run.endedAt}>{when(run.endedAt)}</time>
              </span>
            </>
          )}
          {run.sealedAt === null ? (
            run.endedAt == null ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t("sealNotRecorded")}</span>
              </>
            ) : null
          ) : (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {t("sealed")}{" "}
                <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time>
              </span>
            </>
          )}
        </>
      )}
    </p>
  );
}

/** The agent's last 30 days as `list_agents` counts them: the card's sub line. */
export type AgentFigures = { runs30d: number; spend30d: Cost | null };

/** "<harness> · N runs 30d · $X": the compact agent card's sub line. */
function AgentSub({
  harness,
  figures,
}: {
  harness: string | null;
  figures: AgentFigures | null;
}) {
  const t = useTranslations("run.header");
  const locale = useLocale();
  return (
    <span data-testid="run-agent-sub">
      {harness ?? t("harnessNotRecorded")}
      {figures === null ? null : (
        <>
          {" · "}
          {t("runs30d", { count: formatCount(figures.runs30d, locale) })}
          {figures.spend30d === null ? null : (
            <>
              {" · "}
              <Money value={figures.spend30d} />
            </>
          )}
        </>
      )}
    </span>
  );
}

/**
 * An ended run's word on this page: its lifecycle, `sealed` or `halted`, as
 * `get_run` recorded it (spec pages/run.md, the status words). The outcome the
 * ledger or the collector recorded (`completed`, `failed`, and so on) rides
 * along as the tooltip and the accessible description, because it says how the
 * run ended and the lifecycle word does not. A sealed run is quiet and a halted
 * one reads in the warning ink, so nothing here looks like a done badge.
 * `compacted` needs a compaction record no store keeps yet (#4000).
 */
function EndedStatus({
  status,
  outcome,
}: {
  status: Exclude<RunRow["status"], "live">;
  outcome: RunRow["outcome"];
}) {
  const t = useTranslations("run.header");
  const tu = useTranslations("ui.runStatus");
  const why = t("outcomeTip", { outcome: tu(outcome) });
  return (
    <span
      title={why}
      data-testid="run-status-word"
      data-status={status}
      data-outcome={outcome}
      className="inline-flex"
    >
      <Badge tone={status === "halted" ? "denied" : "quiet"}>
        {t(status === "halted" ? "statusHalted" : "statusSealed")}
      </Badge>
      <span className="sr-only">{why}</span>
    </span>
  );
}

export function RunHeader({
  run,
  agent,
  figures = null,
  parked = false,
  pulls,
  work,
  orgRole,
  wsRole,
  org,
  ws,
}: {
  run: RunRow;
  /** `get_agent` for the run's agent; null when the run names no agent. */
  agent: Read<AgentDetail> | null;
  /** The agent's row from `list_agents`; null when the read did not find it. */
  figures?: AgentFigures | null;
  /** True while a call on this run waits on a person: the status word reads parked. */
  parked?: boolean;
  pulls: readonly RunOutputNode[] | null;
  /**
   * `get_run_work`, started by the page and never awaited by it: the
   * checkout strip reads it inside its own Suspense boundary. Left out, the
   * strip draws the run record alone.
   */
  work?: Promise<Read<RunWork>>;
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
      <div className="flex flex-col gap-4">
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
                <AgentSub harness={harness?.name ?? null} figures={figures} />
              }
            />
            {/* A live run that is paused or has a call parked says which, in
                the word and the dot, because "live" alone hides that nothing
                is moving. An ended run reads its lifecycle word (sealed or
                halted, spec pages/run.md) with its recorded outcome beside it
                as the tooltip, and never a done badge. */}
            {run.status === "live" && run.ingressPaused === true ? (
              <Badge tone="approval" data-testid="run-status-word">
                {t("header.statusPaused")}
              </Badge>
            ) : run.status === "live" && parked ? (
              <Badge tone="approval" data-testid="run-status-word">
                {t("header.statusParked")}
              </Badge>
            ) : run.status === "live" ? (
              <StatusBadge status={run.status} outcome={run.outcome} />
            ) : (
              <EndedStatus status={run.status} outcome={run.outcome} />
            )}
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
          {work === undefined ? (
            <Checkout run={run} pulls={pulls} work={null} />
          ) : (
            <Suspense
              fallback={<Checkout run={run} pulls={pulls} work={null} />}
            >
              <WithWork read={work}>
                {(settled) => (
                  <>
                    <Checkout run={run} pulls={pulls} work={settled} />
                    <Subagents run={run} work={settled} />
                  </>
                )}
              </WithWork>
            </Suspense>
          )}
          <When run={run} />
        </div>
        {/* The action row sits under the strips and the started line, right
            aligned from lg (spec pages/run.md, the mock's header). */}
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
              commandBlock={run.commandBlock}
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
      {run.ingressPaused === true && run.status === "live" ? (
        <div
          role="status"
          data-testid="run-paused"
          className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex flex-col gap-0.5">
            <span>
              <strong className="font-semibold">
                {t("header.pausedTitle")}
              </strong>{" "}
              {t("header.paused")}
            </span>
            <span
              data-gap="pause-facts"
              className="text-xs text-muted-foreground"
            >
              {t("header.pausedFacts")}
            </span>
          </span>
          <PauseBannerActions
            org={org}
            ws={ws}
            runId={run.id}
            source={run.source}
            ingressRevoked={run.ingressRevoked}
            orgRole={orgRole}
            wsRole={wsRole}
          />
        </div>
      ) : null}
    </header>
  );
}
