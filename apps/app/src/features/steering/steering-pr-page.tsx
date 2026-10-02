// One steering PR's page (#5077): `/steering/proposals/prs/<prp_…>`. It shows
// the record the proposal would publish, the pull request on the host with
// its six checks and the writes its state allows, the diff the branch makes,
// the support the proposal cites, and what happened to it, each step marked
// as made in Oxagen or on the repository host.
//
// GitHub (or GitLab) is the truth for the pull request's state. The page
// asks the host once when it opens (RefreshFromHost), offers Refresh from
// GitHub for any time after, and re-reads itself every ten seconds while the
// pull request is open, so a merge or a close on the host shows here without
// a manual step. Every write on the page calls the host first.
//
// The not-loaded states replace the body and keep the shell, as the Steering
// hub's do. An id that could never name a proposal, or one this workspace
// does not hold, is a 404.
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, Suspense } from "react";
import {
  type SteeringPr,
  isSteeringPrKind,
  type ProposalState,
  proposalStateOf,
} from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { PageRecord } from "@/features/shell";
import { getAuthUser } from "@/server/session";
import type { WsCtx } from "@/server/viewer";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes, type SafePath } from "@/shared/safe-path";
import { mayActInWorkspace } from "@/shared/workspace-authority";
import { linkText, mono } from "@/ui/control-styles";
import { LiveRefresh } from "@/ui/live-refresh";
import { PullRequestLink, SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { SteeringPrPanel } from "./steering-pr-panel";
import { CloneCommands, RefreshFromHost } from "./steering-pr-controls";
import { SteeringPrActivity } from "./steering-pr-activity";
import { SteeringPrDiffSection, DiffLoading } from "./steering-pr-diff";
import { SteeringFailure } from "./page-state";
import { Fact, Facts, Section, useDate } from "./section";
import { ProposalStatusBadge } from "./status";
import {
  PROPOSAL_ID,
  type proposalListFrom,
  type SteeringAt,
  steeringLink,
} from "./view";

/** Where the page was opened from: the list's state, size and offset. */
export type ProposalListFrom = ReturnType<typeof proposalListFrom>;

/** The page's shape while its read runs: the header, then three panels. */
export function SteeringPrLoading() {
  const t = useTranslations("steering.pr.page");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid="steering-pr-loading"
      className="flex flex-col gap-4"
    >
      <div className="skeleton h-4 w-40 rounded-md" />
      <div className="skeleton h-10 w-2/3 rounded-md" />
      {[0, 1, 2].map((block) => (
        <div key={block} className="skeleton h-40 rounded-md" />
      ))}
    </div>
  );
}

/** The instant the read was attempted; outside the component, which may not read a clock. */
function instantOfRead(): string {
  return new Date().toISOString();
}

/** A failed read's instant in UTC, as the hub prints it. */
function traceInstant(readAt: string): string {
  return `${readAt.slice(0, 19).replace("T", " ")}Z`;
}

function Crumbs({ back, state }: { back: SafePath; state: ProposalState }) {
  const t = useTranslations("steering.pr.page");
  return (
    <nav aria-label={t("crumbs")} className="text-xs text-muted-foreground">
      <SafeLink to={back} className={linkText} data-testid="steering-pr-back">
        {t(`back.${state}`)}
      </SafeLink>
    </nav>
  );
}

function RecordSection({ pr }: { pr: SteeringPr }) {
  const t = useTranslations("steering.pr.record");
  const record = useTranslations("ui.record");
  const date = useDate();
  const { raised } = pr;
  // A steering PR changes files rather than one record (#5122), so it has no
  // lineage, force, or scope of its own. The panel below names its branch.
  const files = isSteeringPrKind(pr.kind);
  return (
    <Section
      id="steering-pr-record"
      title={files ? t("proposalTitle") : t("title")}
    >
      <blockquote
        data-testid="steering-pr-statement"
        className="max-w-prose border-l-2 border-border ps-3 text-sm text-foreground"
      >
        {raised.statement}
      </blockquote>
      <Facts>
        {files ? null : (
          <Fact name="lineage" term={record("lineage")}>
            <span className={mono}>{pr.lineage}</span>
          </Fact>
        )}
        <Fact name="kind" term={t("kind")}>
          {record(`kinds.${pr.kind}`)}
        </Fact>
        {files ? null : (
          <Fact name="force" term={t("force")}>
            {raised.force}
          </Fact>
        )}
        {raised.constraintEffect === null ? null : (
          <Fact name="effect" term={t("effect")}>
            {record(`effects.${raised.constraintEffect}`)}
          </Fact>
        )}
        {files ? null : (
          <Fact name="scope" term={record("scope")}>
            {record(`scopes.${raised.sharingScope}`)}
          </Fact>
        )}
        <Fact name="raised-by" term={t("raisedBy")}>
          {raised.sourceName ?? <span className={mono}>{raised.source}</span>}
        </Fact>
        <Fact name="raised-at" term={t("raisedAt")}>
          {date(raised.at)}
        </Fact>
      </Facts>
      {raised.rationale === "" ? null : (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t("rationale")}
          </h3>
          <p className="max-w-prose text-sm text-foreground">
            {raised.rationale}
          </p>
        </div>
      )}
    </Section>
  );
}

function SupportList({
  name,
  term,
  items,
  link,
}: {
  name: string;
  term: string;
  items: string[];
  /** Where an item opens, when it names something the app has a page for. */
  link?: (item: string) => SafePath | null;
}) {
  const t = useTranslations("steering.pr.support");
  return (
    <div data-support={name} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{term}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className={`${mono} flex flex-col gap-0.5 text-xs break-all`}>
          {items.map((item) => {
            const to = link?.(item) ?? null;
            return (
              <li key={item}>
                {to === null ? (
                  item
                ) : (
                  <SafeLink to={to} className={linkText}>
                    {item}
                  </SafeLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A run id the Run page can open: a ledger run's `arun_…` public id. */
const RUN_ID = /^arun_[0-9A-Za-z]{1,60}$/;

function SupportSection({ pr, at }: { pr: SteeringPr; at: SteeringAt }) {
  const t = useTranslations("steering.pr.support");
  const { support } = pr.raised;
  return (
    <Section id="steering-pr-support" title={t("title")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SupportList
          name="runs"
          term={t("runs")}
          items={support.runs}
          link={(run) =>
            RUN_ID.test(run) ? routes.run(at.org, at.ws, run) : null
          }
        />
        <SupportList name="agents" term={t("agents")} items={support.agents} />
        <SupportList
          name="records"
          term={t("records")}
          items={support.recordIds}
        />
        <SupportList
          name="evidence"
          term={t("evidence")}
          items={support.evidenceLinks}
        />
      </div>
    </Section>
  );
}

/** The repository's web address: the pull request's URL up to its repository. */
function repositoryUrlOf(prUrl: string, repository: string): string | null {
  try {
    const url = new URL(prUrl);
    return `${url.origin}/${repository}`;
  } catch {
    return null;
  }
}

/**
 * Whether the viewer may merge a steering PR no one approved: an org Owner
 * (#4518), or the workspace's Owner or Admin (#5228).
 */
function canMergeWithoutReview(ctx: WsCtx): boolean {
  return mayActInWorkspace(ctx.orgRole, ctx.wsRole, ["owner"]);
}

export async function SteeringPrPage({
  ctx,
  source,
  proposalId,
  from,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The route's proposal segment. */
  proposalId: string;
  from: ProposalListFrom;
}) {
  // An address that could never name a proposal is a 404 before a read.
  if (!PROPOSAL_ID.test(proposalId)) notFound();
  const at: SteeringAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const readAt = instantOfRead();
  const read = await source.steering.steeringPr(ctx, proposalId);
  if (!read.ok && read.reason === "error" && read.status === 404) notFound();
  if (!read.ok) {
    const user = read.reason === "denied" ? await getAuthUser() : null;
    return (
      <SteeringFailure
        read={read}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
        orgName={ctx.orgName}
        wsSlug={ctx.wsSlug}
        wsRole={ctx.wsRole}
        viewer={user === null ? null : user.name || user.email || null}
        retry={routes.steeringProposal(ctx.orgSlug, ctx.wsSlug, proposalId)}
        readAt={traceInstant(readAt)}
      />
    );
  }
  const value = read.value;
  const { pr, status } = value;
  const listState = from.state ?? proposalStateOf(status);
  const back = steeringLink(at, {
    tab: "proposals",
    state: listState,
    rows: from.rows ?? undefined,
    offset: from.offset ?? undefined,
  });
  const open = status !== "merged" && status !== "rejected";
  // A steering PR open on a `memory/` branch is a memory PR, and its records
  // are read by its number (list_memory_pr_records, #4914).
  const memoryRecords =
    pr !== null && pr.branch.startsWith("memory/") && open
      ? await source.steering.memoryPrRecords(ctx, pr.number)
      : null;
  const prUrl = pr === null ? null : parsePullRequestUrl(pr.url);
  const repositoryUrl =
    pr === null ? null : repositoryUrlOf(pr.url, pr.repository);
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="steering-pr-page"
      data-status={status}
    >
      <PageRecord route="steering" id={proposalId} label={value.lineage} />
      {/* While the pull request is open on the host it can merge or close
          there at any moment; the page re-reads itself to show it. */}
      <LiveRefresh active={open && pr !== null} intervalMs={10_000} />
      <Crumbs back={back} state={listState} />
      <SteeringPrHeader
        value={value}
        actions={
          <>
            {pr === null ? null : (
              <RefreshFromHost
                org={at.org}
                ws={at.ws}
                proposalId={proposalId}
                host={pr.provider}
              />
            )}
            {pr !== null && open && repositoryUrl !== null ? (
              <CloneCommands
                repositoryUrl={repositoryUrl}
                repository={pr.repository}
                branch={pr.branch}
                number={pr.number}
                host={pr.provider}
              />
            ) : null}
          </>
        }
        prLink={
          pr !== null && prUrl !== null ? (
            <PullRequestLink
              to={prUrl}
              data-testid="steering-pr-host-link"
              className={linkText}
            >
              <HostLink number={pr.number} repository={pr.repository} />
            </PullRequestLink>
          ) : null
        }
      />
      <RecordSection pr={value} />
      {/* The read carries the managed blocks the latest check run found
          drifted and the approvals given in Oxagen at the checked head, so
          the panel draws Restore block and the approval count (#4518). */}
      <SteeringPrPanel
        at={at}
        read={read}
        approvals={value.approvals}
        findings={value.findings}
        memoryRecords={memoryRecords}
        canMergeWithoutReview={canMergeWithoutReview(ctx)}
      />
      <Suspense fallback={<DiffLoading />}>
        <SteeringPrDiffSection
          ctx={ctx}
          source={source}
          proposalId={proposalId}
          prUrl={prUrl}
        />
      </Suspense>
      <SupportSection pr={value} at={at} />
      <SteeringPrActivity pr={value} />
    </div>
  );
}

function HostLink({
  number,
  repository,
}: {
  number: number;
  repository: string;
}) {
  const t = useTranslations("steering.pr.page");
  return t("number", { number: String(number), repository });
}

function SteeringPrHeader({
  value,
  actions,
  prLink,
}: {
  value: SteeringPr;
  actions: ReactNode;
  prLink: ReactNode;
}) {
  const t = useTranslations("steering.pr.page");
  return (
    <PageHeader
      eyebrow={t("eyebrow")}
      title={value.lineage}
      mono
      description={value.raised.statement}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <ProposalStatusBadge status={value.status} />
          {prLink}
        </span>
      }
      actions={actions}
    />
  );
}
