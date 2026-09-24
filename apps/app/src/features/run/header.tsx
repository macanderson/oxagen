// The Run page's header (mockup `pRun`'s `.phead`, pages/run.md, Header):
// the eyebrow and the run id, then who ran it and under what tier, the rig it
// ran on, where the work is, when it started, and the actions its status
// allows, always ending on Export.
//
// Every chip shows what the record holds. A fact the record does not capture
// (a harness version the session did not report, the effort setting, a
// checkout the host did not enroll) is said to be missing in words rather
// than left blank or guessed.
import { Folder, GitBranch, GitPullRequest } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, use } from "react";
import type { AgentDetail, AgentPage } from "@/data/contracts/agents";
import type { RunOutputNode } from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { parseGitHubUrl } from "@/shared/github-url";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { Badge } from "@/ui/badge";
import { eyebrow, linkChip } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { GitHubLink } from "@/ui/navigation";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { CopyPath } from "./copy-text";
import { runFit, type RunFit } from "./fit";
import type { RunMetrics } from "./metrics";
import { ExportAction } from "./record-actions";
import { ReplayActions } from "./replay-actions";
import { RunControls } from "./run-controls";
import type { Place } from "./tab-props";

/** `.b.b-q`: the quiet pill every strip chip is. */
function Chip({
  children,
  code = false,
  testId,
  title,
}: {
  children: React.ReactNode;
  code?: boolean;
  testId?: string;
  title?: string;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-flex min-w-0 max-w-full items-center gap-[5px] whitespace-nowrap rounded-md border border-border bg-hl px-[7px] py-0.5 leading-normal tracking-[0.02em] text-muted-foreground ${code ? "font-mono text-[10.5px] font-medium" : "text-[11px] font-semibold"}`}
    >
      {children}
    </span>
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
 * The harness name and its version. What the wrapped session recorded wins
 * over the registry, which names the harness an agent was registered with but
 * never a version.
 */
export function useHarness(run: RunRow, agent: Read<AgentDetail> | null) {
  const ta = useTranslations("agents");
  const registered = harnessOf(agent);
  if (run.harness) {
    return { name: run.harness.name, version: run.harness.version };
  }
  if (registered === null) return null;
  return { name: ta(`harness.${registered}`), version: null };
}

/** `fitBadge`: the reading's word as a state pill; nothing when it read fit or could not read. */
function FitBadges({ fit }: { fit: RunFit }) {
  const t = useTranslations("run.header.fit");
  const model = fit.model;
  if (model === null) return null;
  return model.verdict === "fit" ? (
    <Badge tone="allowed" data-testid="run-fit-model">
      {t("fit")}
    </Badge>
  ) : (
    <Badge tone="approval" data-testid="run-fit-model">
      {t("wrongTier")}
    </Badge>
  );
}

/** The rig: the harness and its version, the model, and the effort setting. */
function Rig({
  run,
  agent,
  fit,
}: {
  run: RunRow;
  agent: Read<AgentDetail> | null;
  fit: RunFit;
}) {
  const t = useTranslations("run.header");
  const harness = useHarness(run, agent);
  const model = run.model;
  return (
    <div
      data-testid="run-rig"
      className="mt-2 flex flex-wrap items-center gap-[9px]"
    >
      <Chip>
        {harness === null ? (
          <span className="font-normal text-dim">
            {t("harnessNotRecorded")}
          </span>
        ) : (
          <>
            {harness.name}
            {harness.version === null ? (
              <span className="font-normal text-dim">
                {t("versionNotCaptured")}
              </span>
            ) : (
              <span className="font-mono font-normal text-dim">
                {harness.version}
              </span>
            )}
          </>
        )}
      </Chip>
      <Chip
        code
        title={
          model === null
            ? undefined
            : [model.provider, model.tier]
                .filter((part): part is string => part !== null)
                .join(" ")
        }
      >
        {model === null ? t("modelNotRecorded") : model.slug}
      </Chip>
      <Chip testId="run-effort" title={t(`effortWhy.${fit.effort.why}`)}>
        {t("effort")}{" "}
        <span className="font-normal text-dim">{t("notCaptured")}</span>
      </Chip>
      <FitBadges fit={fit} />
    </div>
  );
}

function joinFacts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * What the record says about the host, for the machine chip's hover text.
 * A session observation and the enrollment record keep separate labels, so
 * an old enrollment is never read as what the session saw.
 */
function useHostFacts(run: RunRow): string {
  const t = useTranslations("run.header");
  const machine = run.machine;
  if (machine === null) return t("noMachineOnLedger");
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
  ].join(" ");
}

/** The host with no enrolled checkout: its name, and that no path is held. */
function MachineChip({
  run,
  machine,
}: {
  run: RunRow;
  machine: string | null;
}) {
  const t = useTranslations("run.header");
  const facts = useHostFacts(run);
  if (machine === null)
    return (
      <Chip testId="run-machine" title={facts}>
        <span className="text-dim">{t("noMachine")}</span>
      </Chip>
    );
  return (
    <Chip
      code
      testId="run-machine"
      title={`${t("pathNotEnrolled", { machine })} ${facts}`}
    >
      <Folder aria-hidden="true" className="size-3 flex-none" />
      {machine}
      <span className="text-dim">{t("pathNotCaptured")}</span>
    </Chip>
  );
}

/**
 * The checkout strip from what the outputs recorded, while the work read is
 * still in flight or when it failed: the pull requests, and the host.
 */
function WhereFromOutputs({
  run,
  pulls,
}: {
  run: RunRow;
  pulls: readonly RunOutputNode[] | null;
}) {
  const t = useTranslations("run.header");
  return (
    <WhereRow>
      <Chip>{t("repoNotCaptured")}</Chip>
      {pulls === null || pulls.length === 0 ? (
        <Chip>
          <span className="text-dim">{t("noPullRequest")}</span>
        </Chip>
      ) : (
        pulls.map((pull) => (
          <Chip key={`${pull.seq ?? ""}${pull.name}`} code>
            <GitPullRequest aria-hidden="true" className="size-3 flex-none" />
            {pull.name}
          </Chip>
        ))
      )}
      <MachineChip run={run} machine={run.machine?.hostname ?? null} />
    </WhereRow>
  );
}

function WhereRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="run-checkout"
      className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {children}
    </div>
  );
}

/** A link to the forge when the URL is one Oxagen can name, else the text alone. */
function ForgeChip({
  url,
  children,
  code = false,
  title,
}: {
  url: string | null;
  children: React.ReactNode;
  code?: boolean;
  title?: string;
}) {
  const target = parseGitHubUrl(url);
  if (target === null)
    return (
      <Chip code={code} title={title}>
        {children}
      </Chip>
    );
  return (
    <GitHubLink
      to={target}
      title={title}
      className={`${linkChip} ${code ? "font-mono text-[10.5px] font-medium" : ""}`}
    >
      {children}
    </GitHubLink>
  );
}

/**
 * The checkout (`runWhere`): the repository, the branch, one chip per pull
 * request the run pushed to, and `<machine>:<path>` as a copy button. The work
 * read records the checkout the host enrolled, so a path here is stated, never
 * worked out; a run whose host enrolled none says so.
 */
function WhereFromWork({
  read,
  run,
  pulls,
}: {
  read: Promise<Read<RunWork>>;
  run: RunRow;
  pulls: readonly RunOutputNode[] | null;
}) {
  const t = useTranslations("run.header");
  const facts = useHostFacts(run);
  const work = use(read);
  if (!work.ok) return <WhereFromOutputs run={run} pulls={pulls} />;
  const checkout = work.value.checkouts[0] ?? null;
  const repo = checkout?.repository ?? work.value.pullRequests[0]?.repository;
  const prs = work.value.pullRequests;
  // A branch that is a pull request's head links to the pull request, never
  // to `/tree/refs/pull/...`.
  const headPr =
    checkout?.branch === null || checkout === null
      ? undefined
      : prs.find((pr) => pr.headRef === checkout.branch);
  const machine = work.value.machine?.name ?? run.machine?.hostname ?? null;
  return (
    <WhereRow>
      {repo === undefined ? (
        <Chip>
          {/* The branch chip beside it is what was captured, so only the
              repository is named as missing then. */}
          {checkout?.branch == null
            ? t("repoNotCaptured")
            : t("repoOnlyNotCaptured")}
        </Chip>
      ) : (
        <ForgeChip url={repo.url}>
          {repo.owner}/{repo.name}
        </ForgeChip>
      )}
      {checkout?.branch == null ? null : (
        <ForgeChip
          url={
            headPr?.url ??
            (repo === undefined ? null : `${repo.url}/tree/${checkout.branch}`)
          }
          code
        >
          <GitBranch aria-hidden="true" className="size-3 flex-none" />
          {checkout.branch}
        </ForgeChip>
      )}
      {prs.length === 0 ? (
        <Chip>
          <span className="text-dim">{t("noPullRequest")}</span>
        </Chip>
      ) : (
        prs.map((pr) => (
          <ForgeChip
            key={`${pr.repository.url}/${String(pr.number)}`}
            url={pr.url}
            title={pr.title}
            code
          >
            <GitPullRequest aria-hidden="true" className="size-3 flex-none" />
            {pr.repository.owner}/{pr.repository.name}#{pr.number}
          </ForgeChip>
        ))
      )}
      {machine === null || checkout === null ? (
        <MachineChip run={run} machine={machine} />
      ) : (
        <CopyPath
          text={`${machine}:${checkout.path}`}
          title={`${t("pathRecorded", { machine })} ${facts}`}
        />
      )}
    </WhereRow>
  );
}

/** "<task title> · started <t>", with "· sealed <t>" once sealed. */
function When({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "medium" });
  const title =
    (run.enrichmentEnabled === false ? null : run.name) ?? run.taskRef;
  return (
    <p
      data-testid="run-when"
      className="mt-2 max-w-[70ch] text-[13px] text-muted-foreground"
    >
      {title === null ? null : <>{title} · </>}
      {t("started")} <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
      {run.sealedAt === null ? null : (
        <>
          {" · "}
          {t("sealed")}{" "}
          <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time>
        </>
      )}
    </p>
  );
}

/** One row of the Agents table: the agent's 30-day runs and spend. */
type AgentRow = AgentPage["agents"][number];

/**
 * The compact agent card's line (`agentCard` compact): the harness, then the
 * agent's runs and spend over 30 days where the Agents read carried its row.
 */
function AgentLine({
  run,
  agent,
  roster,
}: {
  run: RunRow;
  agent: Read<AgentDetail> | null;
  roster: AgentRow | null;
}) {
  const t = useTranslations("run.header");
  const locale = useLocale();
  const harness = useHarness(run, agent);
  return (
    <>
      {harness === null ? t("harnessNotRecorded") : harness.name}
      {roster === null ? null : (
        <>
          {" · "}
          {t("runs30d", { count: formatCount(roster.runs30d, locale) })}
          {roster.spend30d === null ? null : (
            <>
              {" · "}
              <Money value={roster.spend30d} />
            </>
          )}
        </>
      )}
    </>
  );
}

/** "Paused" or "Paused at …": the banner under the header while ingress is held. */
function PauseBanner({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  if (run.ingressPaused !== true) return null;
  return (
    <p
      role="status"
      data-testid="run-paused"
      className="mb-3.5 rounded-[10px] border border-info/40 bg-info/10 px-3.5 py-[11px] text-[12.5px] text-foreground"
    >
      <b className="text-info">{t("pausedTitle")}</b> {t("paused")}
    </p>
  );
}

export function RunHeader({
  run,
  agent,
  roster,
  work,
  pulls,
  metrics,
  orgRole,
  wsRole,
  place,
}: {
  run: RunRow;
  /** `get_agent` for the run's agent; null when the run names no agent. */
  agent: Read<AgentDetail> | null;
  /** The agent's row on the Agents table's first page; null when it is not there. */
  roster: AgentRow | null;
  /** `get_run_work`, started by the page: the checkout strip awaits it. */
  work: Promise<Read<RunWork>>;
  /** The pull requests the outputs recorded; null when the outputs read failed. */
  pulls: readonly RunOutputNode[] | null;
  metrics: RunMetrics;
  /**
   * The viewer's two roles, because the writes gate on them differently:
   * `dispatch_command` admits an org Owner or Admin or a workspace Owner or
   * Member, `export_run` an org Owner or Admin. Each control is drawn
   * disabled for a viewer its handler would refuse.
   */
  orgRole: OrgRole;
  wsRole: WsRole;
  place: Place;
}) {
  const t = useTranslations("run");
  const fit = runFit(run, metrics);
  const sealed = run.status !== "live";
  return (
    <>
      <header
        data-testid="run-header"
        className="mb-[18px] flex flex-wrap items-start gap-[18px]"
      >
        <div className="min-w-0">
          <p className={`${eyebrow} mb-2.5`}>{t("header.eyebrow")}</p>
          <h1 className="mb-1 break-all font-mono text-[19px] font-bold leading-tight text-foreground">
            {run.id}
          </h1>
          <div
            data-testid="run-chips"
            aria-label={t("header.chips")}
            className="mt-2 flex flex-wrap items-center gap-[9px]"
          >
            <AgentCard
              layout="compact"
              agentKey={run.agentKey}
              notRecorded={t("notRecorded")}
              sub={<AgentLine run={run} agent={agent} roster={roster} />}
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
              <Chip testId="run-task">
                {t("header.task", { ref: run.taskRef })}
              </Chip>
            )}
          </div>
          <Rig run={run} agent={agent} fit={fit} />
          <Suspense fallback={<WhereFromOutputs run={run} pulls={pulls} />}>
            <WhereFromWork read={work} run={run} pulls={pulls} />
          </Suspense>
          <When run={run} />
          {run.completenessGaps.length === 0 ? null : (
            <p
              data-testid="run-gaps"
              className="mt-1 max-w-prose text-xs text-muted-foreground"
            >
              {t("gaps")}{" "}
              {run.completenessGaps.map((gap) => t(`gap.${gap}`)).join(", ")}
            </p>
          )}
        </div>
        <div
          data-testid="run-actions"
          className="ml-auto flex flex-wrap items-start gap-2"
        >
          {sealed ? (
            <ReplayActions org={place.org} ws={place.ws} run={run} />
          ) : (
            <RunControls
              org={place.org}
              ws={place.ws}
              runId={run.id}
              status={run.status}
              source={run.source}
              enforcementTier={run.enforcementTier}
              ingressRevoked={run.ingressRevoked}
              ingressPaused={run.ingressPaused}
              orgRole={orgRole}
              wsRole={wsRole}
            />
          )}
          <ExportAction
            org={place.org}
            ws={place.ws}
            runId={run.id}
            sealed={sealed}
            orgRole={orgRole}
          />
        </div>
      </header>
      <PauseBanner run={run} />
    </>
  );
}
