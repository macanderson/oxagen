// The Run page's header (mockup `pRun`'s `.phead`, pages/run.md, Header):
// the eyebrow and the run id, then who ran it and under what tier, the rig it
// ran on, where the work is, when it started, and the actions its status
// allows, always ending on Export.
//
// Every chip shows what the record holds. A fact the record does not capture
// (a harness version the session did not report, an effort setting no frame
// carried, a checkout the host did not enroll) is said to be missing in words
// rather than left blank or guessed. The rig adds the thinking and permission
// mode a session recorded, and a subagents row appears under the checkout
// when the session started any; the design draws neither, and both show only
// what the record holds.
import { Folder, GitBranch, GitPullRequest } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, use } from "react";
import type { AgentDetail, AgentPage } from "@/data/contracts/agents";
import type { RunOutputNode } from "@/data/contracts/run";
import type { RunSubagent, RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { parseGitHubUrl } from "@/shared/github-url";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import type { OrgRole, WsRole } from "@/server/viewer";
import { AgentCard } from "@/ui/agent-card";
import { Badge } from "@/ui/badge";
import { eyebrow, linkChip } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { GitHubLink, PullRequestLink } from "@/ui/navigation";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { StatusBadge } from "@/ui/status-badge";
import { CopyPath } from "./copy-text";
import { effortVerdict, fitOf, runEffort } from "./fit";
import { ExportAction } from "./record-actions";
import { ReplayActions } from "./replay-actions";
import { RunControls } from "./run-controls";
import { SealRunAction } from "./seal-run";
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

/**
 * `fitBadge`: the stored reading's words as state pills (ADR-194), one for
 * the model class and one for the effort. None on a live run or a run with no
 * reading, none for a class the reading placed on no ladder, and none for an
 * effort it did not see or whose value is not the one the rig prints.
 */
function FitBadges({ run }: { run: RunRow }) {
  const t = useTranslations("run.header.fit");
  const model = fitOf(run)?.model ?? null;
  const effort = effortVerdict(run);
  return (
    <>
      {model === null ? null : model.verdict === "fit" ? (
        <Badge tone="allowed" data-testid="run-fit-model">
          {t("fit")}
        </Badge>
      ) : (
        <Badge tone="approval" data-testid="run-fit-model">
          {t("wrongTier")}
        </Badge>
      )}
      {effort === null ? null : effort.verdict === "fit" ? (
        <Badge tone="allowed" data-testid="run-fit-effort">
          {t("effortFit")}
        </Badge>
      ) : (
        <Badge tone="approval" data-testid="run-fit-effort">
          {t("wrongEffort")}
        </Badge>
      )}
    </>
  );
}

/** The rig: the harness and its version, the model, and the effort setting. */
function Rig({
  run,
  agent,
}: {
  run: RunRow;
  agent: Read<AgentDetail> | null;
}) {
  const t = useTranslations("run.header");
  const harness = useHarness(run, agent);
  const model = run.model;
  const effort = runEffort(run);
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
      {/* The value only where the record holds it, titled with where it was
          read; otherwise not captured, titled with why (#3891). */}
      {effort.seen ? (
        <Chip testId="run-effort" title={t(`effortSource.${effort.source}`)}>
          {t("effort")} {t("effortValue", { value: effort.value })}
        </Chip>
      ) : (
        <Chip testId="run-effort" title={t(`effortWhy.${effort.why}`)}>
          {t("effort")}{" "}
          <span className="font-normal text-dim">{t("notCaptured")}</span>
        </Chip>
      )}
      {run.thinking == null ? null : (
        <Chip testId="run-thinking">
          {run.thinking ? t("thinkingOn") : t("thinkingOff")}
        </Chip>
      )}
      {run.permissionMode == null ? null : (
        <Chip testId="run-permission-mode" code>
          {t("permissionMode", { value: run.permissionMode })}
        </Chip>
      )}
      <FitBadges run={run} />
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
      title={t("withFacts", {
        reading: t("pathNotEnrolled", { machine }),
        facts,
      })}
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
          <PullChip
            key={`${pull.seq ?? ""}${pull.name}`}
            url={pull.note}
            label={recordedPullLabel(pull)}
            state={null}
          />
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
 * A pull request's chip and its state beside it. The chip opens the pull
 * request on GitHub or GitLab in a new tab when its URL names a page Oxagen
 * recognises, else it is the label alone. `state` is the live state the work
 * read took from the forge; a pull request only the frames recorded has none
 * Oxagen can vouch for, and says "status unknown" rather than "open".
 */
function PullChip({
  url,
  label,
  title,
  state,
}: {
  url: string | null;
  label: string;
  title?: string;
  state: RunWork["pullRequests"][number]["state"] | null;
}) {
  const t = useTranslations("run.header");
  const target = url === null ? null : parsePullRequestUrl(url);
  const content = (
    <>
      <GitPullRequest aria-hidden="true" className="size-3 flex-none" />
      {label}
    </>
  );
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {target === null ? (
        <ForgeChip url={url} title={title} code>
          {content}
        </ForgeChip>
      ) : (
        <PullRequestLink
          to={target}
          title={title}
          className={`${linkChip} font-mono text-[10.5px] font-medium`}
        >
          {content}
        </PullRequestLink>
      )}
      <span
        data-testid="run-pull-state"
        data-state={state ?? "unknown"}
        className="whitespace-nowrap text-[10.5px] text-dim"
      >
        {state === null ? t("pullState.unknown") : t(`pullState.${state}`)}
      </span>
    </span>
  );
}

/**
 * A recorded pull request as a person names it: `owner/repo#12` when the
 * spine names the repository beside a bare `#12`, else the node's own name.
 */
function recordedPullLabel(node: RunOutputNode): string {
  return node.where !== null && node.name.startsWith("#")
    ? `${node.where}${node.name}`
    : node.name;
}

/** Does a recorded pull-request node name this pull request from the work read? */
function samePull(
  node: RunOutputNode,
  pr: RunWork["pullRequests"][number],
): boolean {
  if (node.note !== null && node.note === pr.url) return true;
  const repo = `${pr.repository.owner}/${pr.repository.name}`.toLowerCase();
  return (
    recordedPullLabel(node).toLowerCase() === `${repo}#${String(pr.number)}`
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
  const checkout = latestCheckout(work.value);
  const repo = checkout?.repository ?? work.value.pullRequests[0]?.repository;
  const prs = work.value.pullRequests;
  // A branch that is a pull request's head links to the pull request, never
  // to `/tree/refs/pull/...`.
  const headPr =
    checkout?.branch === null || checkout === null
      ? undefined
      : prs.find((pr) => pr.headRef === checkout.branch);
  const machine = work.value.machine?.name ?? run.machine?.hostname ?? null;
  // A pull request the frames recorded that the work read could not read
  // back (its repository is not connected, or it is a GitLab merge request)
  // is still the run's: it is listed with its link and no state.
  const recordedOnly = (pulls ?? []).filter(
    (node) => !prs.some((pr) => samePull(node, pr)),
  );
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
      {prs.length === 0 && recordedOnly.length === 0 ? (
        <Chip>
          <span className="text-dim">{t("noPullRequest")}</span>
        </Chip>
      ) : (
        <>
          {prs.map((pr) => (
            <PullChip
              key={`${pr.repository.url}/${String(pr.number)}`}
              url={pr.url}
              title={pr.title}
              label={`${pr.repository.owner}/${pr.repository.name}#${String(pr.number)}`}
              state={pr.state}
            />
          ))}
          {recordedOnly.map((node) => (
            <PullChip
              key={`${node.seq ?? ""}${node.name}`}
              url={node.note}
              label={recordedPullLabel(node)}
              state={null}
            />
          ))}
        </>
      )}
      {machine === null || checkout === null ? (
        <MachineChip run={run} machine={machine} />
      ) : (
        <CopyPath
          text={`${machine}:${checkout.path}`}
          title={t("withFacts", {
            reading: t("pathRecorded", { machine }),
            facts,
          })}
        />
      )}
    </WhereRow>
  );
}

/** Seqs are decimal strings: the longer one is later, then the larger. */
function laterSeq(a: string, b: string): boolean {
  return a.length === b.length ? a > b : a.length > b.length;
}

/** The checkout the session touched last; null when the host recorded none. */
function latestCheckout(work: RunWork): RunWork["checkouts"][number] | null {
  return work.checkouts.reduce<RunWork["checkouts"][number] | null>(
    (latest, checkout) =>
      latest === null || laterSeq(checkout.lastSeq, latest.lastSeq)
        ? checkout
        : latest,
    null,
  );
}

/** Subagent chips drawn before the rest are counted as "N more". */
const SUBAGENT_CHIPS = 12;

function SubagentChip({
  subagent,
  live,
}: {
  subagent: RunSubagent;
  live: boolean;
}) {
  const t = useTranslations("run.header");
  return (
    <Chip code title={subagent.agentRef}>
      {subagent.type ?? (
        <span className="font-normal text-dim">
          {t("subagentTypeNotRecorded")}
        </span>
      )}
      <span className="font-normal text-dim">
        {subagent.agentRef.slice(0, 7)}
      </span>
      {subagent.stopped ? null : (
        <span className="font-normal text-dim">
          {live ? t("subagentRunning") : t("subagentNoStop")}
        </span>
      )}
    </Chip>
  );
}

/**
 * The subagents the session started, one chip per recorded agent id, from
 * the same work read as the checkout. The design draws no such row, so it
 * appears only when the session started at least one.
 */
function SubagentsFromWork({
  read,
  run,
}: {
  read: Promise<Read<RunWork>>;
  run: RunRow;
}) {
  const t = useTranslations("run.header");
  const work = use(read);
  const subagents = work.ok ? (work.value.subagents ?? []) : [];
  if (subagents.length === 0) return null;
  return (
    <div
      data-testid="run-subagents"
      className="mt-2 flex flex-wrap items-center gap-[9px]"
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
        {t("subagents")}
      </span>
      {subagents.slice(0, SUBAGENT_CHIPS).map((subagent) => (
        <SubagentChip
          key={subagent.agentRef}
          subagent={subagent}
          live={run.status === "live"}
        />
      ))}
      {subagents.length > SUBAGENT_CHIPS ? (
        <span className="text-[11px] text-dim">
          {t("moreSubagents", { count: subagents.length - SUBAGENT_CHIPS })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * "<task title> · started <t>", then how it ended once the status says it
 * has: Oxagen's close of a run silent for 12 hours, named as such, else the
 * recorder's end time, else the seal, which is the server's receipt
 * time and can trail the run by the upload. Keyed on the status, the one
 * definition of sealed the actions and summarize_run also gate on, so a run
 * that ended with no seal instant says so rather than looking live.
 */
function When({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "medium" });
  // With automatic names off, get_run already sends the harness's own title
  // as `name` (or null), so the header takes it as sent.
  const title = run.name ?? run.taskRef;
  return (
    <p
      data-testid="run-when"
      className="mt-2 max-w-[70ch] text-[13px] text-muted-foreground"
    >
      {title === null ? null : <>{title} · </>}
      {t("started")} <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
      {run.status === "live" ? null : run.sealSource === "idle_timeout" &&
        run.sealedAt != null ? (
        // Oxagen closed it for silence (#3980); the host never said it ended,
        // and its next event reopens it.
        <span data-testid="run-closed-idle">
          {" · "}
          {t("closedIdle")}{" "}
          <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time> (
          {t("closedIdleWhy")})
        </span>
      ) : run.sealSource === "operator" && run.sealedAt != null ? (
        // A person sealed it (ADR-169); the host never said it ended.
        <span data-testid="run-sealed-operator">
          {" · "}
          {t("sealedByOperator")}{" "}
          <time dateTime={run.sealedAt}>{when(run.sealedAt)}</time>
        </span>
      ) : run.endedAt != null ? (
        <span data-testid="run-ended">
          {" · "}
          {t("ended")} <time dateTime={run.endedAt}>{when(run.endedAt)}</time>
        </span>
      ) : run.sealedAt === null ? (
        <>
          {" · "}
          {t("sealNotRecorded")}
        </>
      ) : (
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

/**
 * The run's state word. A live run that is paused, or has a call parked for
 * approval, says which, because "live" and a pulsing dot read as a run that
 * is moving when it is waiting on a person. Paused wins over parked: a paused
 * run takes no step whatever its calls are waiting on.
 *
 * The word sits in a polite live region, so when a refresh of the page parks
 * a call or pauses the run, a screen reader hears the new word.
 */
function RunStatusWord({ run, parked }: { run: RunRow; parked: boolean }) {
  const t = useTranslations("run.header");
  const live = run.status === "live";
  return (
    <span role="status" data-testid="run-status" className="inline-flex">
      {live && run.ingressPaused === true ? (
        <Badge tone="approval" data-status="paused">
          {t("statusPaused")}
        </Badge>
      ) : live && parked ? (
        <Badge tone="approval" data-status="parked">
          {t("statusParked")}
        </Badge>
      ) : (
        <StatusBadge status={run.status} outcome={run.outcome} />
      )}
    </span>
  );
}

/**
 * The banner under the header while the run is paused. A ledger run's ingress
 * fence holds every step. A wrapped run's host refuses its tool calls, and the
 * model may still write text, so each source gets its own sentence.
 */
function PauseBanner({ run }: { run: RunRow }) {
  const t = useTranslations("run.header");
  if (run.status !== "live" || run.ingressPaused !== true) return null;
  return (
    <p
      role="status"
      data-testid="run-paused"
      data-source={run.source}
      className="mb-3.5 rounded-[10px] border border-info/40 bg-info/10 px-3.5 py-[11px] text-[12.5px] text-foreground"
    >
      <b className="text-info">{t("pausedTitle")}</b>{" "}
      {run.source === "tacho" ? t("pausedSession") : t("paused")}
    </p>
  );
}

export function RunHeader({
  run,
  agent,
  roster,
  work,
  pulls,
  orgRole,
  wsRole,
  place,
  parked = false,
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
  /**
   * The viewer's two roles, because the writes gate on them differently:
   * `dispatch_command` admits an org Owner or Admin or a workspace Owner or
   * Member, `export_run` an org Owner or Admin. Each control is drawn
   * disabled for a viewer its handler would refuse.
   */
  orgRole: OrgRole;
  wsRole: WsRole;
  place: Place;
  /** A call on this run is parked for approval. */
  parked?: boolean;
}) {
  const t = useTranslations("run");
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
            <RunStatusWord run={run} parked={parked} />
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
          <Rig run={run} agent={agent} />
          <Suspense fallback={<WhereFromOutputs run={run} pulls={pulls} />}>
            <WhereFromWork read={work} run={run} pulls={pulls} />
          </Suspense>
          <Suspense fallback={null}>
            <SubagentsFromWork read={work} run={run} />
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
              commandBlock={run.commandBlock}
              steerBlock={run.steerBlock}
              ingressRevoked={run.ingressRevoked}
              ingressPaused={run.ingressPaused}
              orgRole={orgRole}
              wsRole={wsRole}
            />
          )}
          {/* A wrapped run the control plane still reads as live, or closed
              only for silence, can be sealed by a person (ADR-169). A
              ledger run seals when its producer does. */}
          {run.source === "tacho" &&
          (run.status === "live" || run.sealSource === "idle_timeout") ? (
            <SealRunAction
              org={place.org}
              ws={place.ws}
              runId={run.id}
              commandBlock={run.commandBlock ?? null}
              orgRole={orgRole}
              wsRole={wsRole}
            />
          ) : null}
          <ExportAction
            org={place.org}
            ws={place.ws}
            runId={run.id}
            sealed={sealed}
            closedIdle={run.sealSource === "idle_timeout"}
            orgRole={orgRole}
          />
        </div>
      </header>
      <PauseBanner run={run} />
    </>
  );
}
