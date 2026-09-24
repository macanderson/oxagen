// The Run page's header (mockup `pRun`, spec pages/run.md): who ran it and
// under what tier, the rig it ran on, where it ran, when, and the controls the
// run's status allows. RunTitle draws the page's h1: the run's human title,
// with the id under it, or the id alone when the run has no title.
//
// Every chip shows what the record holds. The rig reads the session row
// (model, effort, permission mode), the checkout and subagent strips read
// `get_run_work` (the worktree frames and the subagent hook frames), and the
// usage strip reads the session's token counts, which ingest sums from its
// `llm_call` frames. A fact the record does not hold is said to be missing in
// words rather than left blank or guessed. The model-fit reading the mockup
// draws is left out because nothing records it.
import { useLocale, useTranslations } from "next-intl";
import { Suspense, use } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunOutputNode } from "@/data/contracts/run";
import type { RunWork, RunSubagent } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { parseGitHubUrl } from "@/shared/github-url";
import { AgentCard } from "@/ui/agent-card";
import { mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { GitHubLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { PageHeader } from "@/ui/page-header";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { CopyText } from "./copy-text";
import { EnrichmentSwitch } from "./enrichment-switch";
import { RecordActions } from "./record-actions";
import { RunControls } from "./run-controls";

const chip = `${mono} inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-0.5 text-[11.5px]`;
const missing = "text-[11.5px] text-muted-foreground";

/** Subagent chips drawn before the rest are counted as "N more". */
const SUBAGENT_CHIPS = 12;

/** One labelled row of chips: the rig, the checkout, the subagents or the usage. */
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
      <span className="w-20 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
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
      {run.effort == null ? (
        <span className={missing}>{t("effortNotRecorded")}</span>
      ) : (
        <span data-testid="run-effort" className={chip}>
          {t("effort", { value: run.effort })}
        </span>
      )}
      {run.thinking == null ? null : (
        <span data-testid="run-thinking" className={chip}>
          {run.thinking ? t("thinkingOn") : t("thinkingOff")}
        </span>
      )}
      {run.permissionMode == null ? (
        <span className={missing}>{t("permissionModeNotRecorded")}</span>
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

/** Seqs are decimal strings: the longer one is later, then the larger. */
function laterSeq(a: string, b: string): boolean {
  return a.length === b.length ? a > b : a.length > b.length;
}

/** The checkout the session touched last, and how many others it recorded. */
function primaryCheckout(work: RunWork) {
  const primary = work.checkouts.reduce<RunWork["checkouts"][number] | null>(
    (latest, checkout) =>
      latest === null || laterSeq(checkout.lastSeq, latest.lastSeq)
        ? checkout
        : latest,
    null,
  );
  return { primary, others: Math.max(work.checkouts.length - 1, 0) };
}

function RepoLink({ url, children }: { url: string; children: string }) {
  const target = parseGitHubUrl(url);
  return target ? (
    <GitHubLink to={target} className="underline underline-offset-4">
      {children}
    </GitHubLink>
  ) : (
    <span>{children}</span>
  );
}

function PullChips({ pulls }: { pulls: readonly RunOutputNode[] | null }) {
  const t = useTranslations("run.header");
  if (pulls === null) return null;
  if (pulls.length === 0) {
    return <span className={missing}>{t("noPullRequest")}</span>;
  }
  return pulls.map((pull) => (
    <span
      key={`${pull.seq ?? ""}${pull.name}`}
      data-testid="run-pull"
      className={chip}
    >
      {pull.note?.startsWith("https://") ? (
        <RepoLink url={pull.note}>{pull.name}</RepoLink>
      ) : (
        pull.name
      )}
      {pull.where === null ? null : (
        <span className="text-muted-foreground">{pull.where}</span>
      )}
    </span>
  ));
}

/**
 * The output PR nodes the work read did not already answer. Both reads carry
 * a harness PR link, so the same PR would otherwise be drawn twice. The work
 * read wins, since it carries the PR's state from GitHub.
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

function Hostname({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  return run.machine === null ? (
    <span className={missing}>{t("noMachine")}</span>
  ) : (
    <CopyText text={run.machine.hostname} />
  );
}

/**
 * The checkout strip: repository, branch, pull requests, machine and the
 * local directory, from the worktree frames `get_run_work` reads. A session
 * that moved between checkouts shows the one it touched last and counts the
 * rest. When the work read fails, the pull requests fall back to the ones the
 * run's outputs recorded.
 */
function Checkout({
  run,
  pulls,
  work,
}: {
  run: RunRow;
  /** The pull requests the outputs recorded; null when the outputs read failed. */
  pulls: readonly RunOutputNode[] | null;
  work: Read<RunWork>;
}) {
  const t = useTranslations("run.header");
  if (!work.ok) {
    return (
      <Strip label={t("checkout")} testId="run-checkout">
        <span className={missing}>{t("workUnread")}</span>
        <PullChips pulls={pulls} />
        <Hostname run={run} />
      </Strip>
    );
  }
  const { primary, others } = primaryCheckout(work.value);
  const repository = primary?.repository ?? null;
  const recordedPulls = work.value.pullRequests;
  const extraPulls = pullsBeyond(pulls, recordedPulls);
  return (
    <Strip label={t("checkout")} testId="run-checkout">
      {repository === null ? (
        <span className={missing}>{t("repoNotRecorded")}</span>
      ) : (
        <span data-testid="run-repository" className={chip}>
          <RepoLink url={repository.url}>
            {`${repository.owner}/${repository.name}`}
          </RepoLink>
        </span>
      )}
      {primary?.branch == null ? (
        <span className={missing}>{t("branchNotRecorded")}</span>
      ) : (
        <span data-testid="run-branch" className={chip}>{primary.branch}</span>
      )}
      {recordedPulls.length === 0 ? (
        <PullChips pulls={pulls} />
      ) : (
        <>
          {recordedPulls.map((pr) => (
            <span
              key={`${pr.repository.url}#${String(pr.number)}`}
              data-testid="run-pull"
              className={chip}
            >
              <RepoLink url={pr.url}>{`#${String(pr.number)}`}</RepoLink>
              <span className="text-muted-foreground">{pr.state}</span>
            </span>
          ))}
          {extraPulls.length === 0 ? null : <PullChips pulls={extraPulls} />}
        </>
      )}
      <Hostname run={run} />
      {primary === null ? (
        <span className={missing}>{t("pathNotRecorded")}</span>
      ) : (
        <CopyText text={primary.path} />
      )}
      {others === 0 ? null : (
        <span className={missing}>{t("moreCheckouts", { count: others })}</span>
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
    <span className={chip} title={subagent.id}>
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

/** The subagents the session started, one chip per recorded agent id. */
function Subagents({ run, work }: { run: RunRow; work: Read<RunWork> }) {
  const t = useTranslations("run.header");
  const subagents = work.ok ? (work.value.subagents ?? []) : null;
  return (
    <Strip label={t("subagents")} testId="run-subagents">
      {subagents === null ? (
        <span className={missing}>{t("subagentsUnread")}</span>
      ) : subagents.length === 0 ? (
        <span className={missing}>{t("noSubagents")}</span>
      ) : (
        <>
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
        </>
      )}
    </Strip>
  );
}

/** The two strips `get_run_work` feeds, drawn once its read settles. */
function WorkStrips({
  run,
  pulls,
  work,
}: {
  run: RunRow;
  pulls: readonly RunOutputNode[] | null;
  work: Promise<Read<RunWork>>;
}) {
  const read = use(work);
  return (
    <>
      <Checkout run={run} pulls={pulls} work={read} />
      <Subagents run={run} work={read} />
    </>
  );
}

function WorkStripsLoading() {
  const t = useTranslations("run.header");
  return (
    <Strip label={t("checkout")} testId="run-checkout-loading">
      <span role="status" className={missing}>
        {t("workLoading")}
      </span>
    </Strip>
  );
}

/**
 * Token counts and cost. The counts are the session's sums over its `llm_call`
 * frames. The cost is the finalized rollup when there is one, and otherwise
 * what the agent reported, marked as such.
 */
function Usage({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const locale = useLocale();
  const tokens = run.reportedTokens ?? null;
  const cost = run.cost ?? run.reportedCost ?? null;
  const count = (n: number) => formatCount(n, locale);
  return (
    <Strip label={t("usage")} testId="run-usage">
      {tokens === null ? (
        <span className={missing}>{t("tokensNotRecorded")}</span>
      ) : (
        <>
          <span className={chip}>
            {t("tokensInput", { count: count(tokens.input) })}
          </span>
          <span className={chip}>
            {t("tokensOutput", { count: count(tokens.output) })}
          </span>
          <span className={chip}>
            {t("tokensCacheRead", { count: count(tokens.cacheRead) })}
          </span>
          <span className={chip}>
            {t("tokensCacheWrite", { count: count(tokens.cacheWrite) })}
          </span>
        </>
      )}
      {cost === null ? (
        <span className={missing}>{t("costNotRecorded")}</span>
      ) : (
        <span data-testid="run-usage-cost" className={chip}>
          <Money value={cost} />
          {run.cost === null ? (
            <span className="text-muted-foreground">{t("costReported")}</span>
          ) : null}
        </span>
      )}
    </Strip>
  );
}

/**
 * The run's human title: the name its harness gave it or Oxagen generated,
 * then its task reference. Null when the run carries neither. Turning
 * automatic names off stops Oxagen writing one; it never hides the title the
 * harness recorded, which the server answers as the name.
 */
function titleOf(run: RunRow): string | null {
  return run.name ?? run.taskRef;
}

/**
 * The page's h1 (spec pages/run.md). A run with a title leads with it and
 * keeps its id under it in mono with a copy button. A run with no title is
 * named by its id. The error path passes the id alone, since no run was read.
 */
export function RunTitle({ id, run }: { id: string; run: RunRow | null }) {
  const t = useTranslations("pages");
  const title = run === null ? null : titleOf(run);
  return title === null ? (
    <PageHeader eyebrow={t("run")} title={id} mono />
  ) : (
    <PageHeader
      eyebrow={t("run")}
      title={title}
      description={<CopyText text={id} />}
    />
  );
}

/** "started <t> by <operator> · ended <t>". */
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
  return (
    <p
      data-testid="run-when"
      className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground"
    >
      <span>
        {t("started")}{" "}
        <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
      </span>
      <span data-testid="run-operator">
        {run.operatorAttribution === "host_enroller"
          ? t("enrolledBy")
          : t("by")}{" "}
        {operator}
      </span>
      <span aria-hidden="true">·</span>
      {/* One definition of sealed across the header: the run's status, the
          same one RecordActions and summarize_run gate on. A run that ended
          without a recorded seal instant says so rather than "still running".
          The recorder's end time wins over the seal, which is the server's
          receipt time and can trail the run by the upload. */}
      {run.status === "live" ? (
        <span>{t("running")}</span>
      ) : run.endedAt != null ? (
        <span data-testid="run-ended">
          {t("ended")}{" "}
          <time dateTime={run.endedAt}>{when(run.endedAt)}</time>
        </span>
      ) : run.sealedAt === null ? (
        <span>{t("sealNotRecorded")}</span>
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
  work,
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
   * `get_run_work`, started by the page and not awaited, so the checkout and
   * subagent strips stream in without holding the rest of the header.
   */
  work: Promise<Read<RunWork>>;
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
            {run.taskRef === null || titleOf(run) === run.taskRef ? null : (
              <span data-testid="run-task" className={chip}>
                {run.taskRef}
              </span>
            )}
          </div>
          <Rig run={run} agent={agent} />
          <Suspense fallback={<WorkStripsLoading />}>
            <WorkStrips run={run} pulls={pulls} work={work} />
          </Suspense>
          <Usage run={run} />
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
            commandBlock={run.commandBlock}
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
