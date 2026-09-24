// The Issues tab (spec pages/run.md, `issuesTab` and `linkedWork`): every
// issue the session touched, then the work it linked to.
//
// The run record keeps one task reference, so the table has at most one row:
// the task the run was started on, whose relation is `task` and whose edge is
// `stated`, because the producer stated it rather than Oxagen observing it. A
// reference in the `owner/repo#N` shape links to that issue on GitHub; any
// other shape names no tracker page, and says so. The tracker's own status is
// not read (no connection reads it yet), so the cell says that.
//
// Linked work reads `get_run_work` for the repositories and pull requests,
// each a link to the forge, and the outputs spine for the commits and the
// files they changed, each with the frame that recorded it. With no work
// evidence the repository panel says so rather than guessing one from a
// branch name.
import { useLocale, useTranslations } from "next-intl";
import type { RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { ReactNode } from "react";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { type GitHubUrl, parseGitHubUrl } from "@/shared/github-url";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { eyebrow, linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { GitHubLink, SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Panel } from "./parts";
import {
  checkoutOf,
  ForgeLink,
  pullName,
  repositoriesOf,
  type RunWorkPull,
  workOf,
} from "./work-ci";

type Place = { org: string; ws: string; runId: string };

const GITHUB_ISSUE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** The tracker page for a reference, when its shape names one. */
export function issueUrl(ref: string): GitHubUrl | null {
  const match = GITHUB_ISSUE.exec(ref.trim());
  if (match === null) return null;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined)
    return null;
  return parseGitHubUrl(`https://github.com/${owner}/${repo}/issues/${number}`);
}

/** `observed · fr N` for a node a frame recorded; `stated` otherwise. */
function EdgeChip({ seq, place }: { seq: string | null; place: Place }) {
  const t = useTranslations("run.issues");
  if (seq === null) {
    return <Badge tone="quiet">{t("edge.stated")}</Badge>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="allowed">{t("edge.observed")}</Badge>
      <SafeLink
        to={routes.run(place.org, place.ws, place.runId, {
          tab: "actions",
          body: seq,
        })}
        className={`${mono} text-[11px] text-muted-foreground hover:text-foreground`}
      >
        {t("frame", { seq })}
      </SafeLink>
    </span>
  );
}

/**
 * How many issues the session touched: the one task reference the run record
 * keeps, or none. The Issues tab's count and its table both read this.
 */
export function issueCount(run: Pick<RunRow, "taskRef">): number {
  return run.taskRef === null ? 0 : 1;
}

function IssuesTable({ run }: { run: RunRow }) {
  const t = useTranslations("run.issues");
  const ref = run.taskRef;
  const url = ref === null ? null : issueUrl(ref);
  return (
    <Panel
      title={t("title")}
      aside={
        <Badge tone="quiet" dot={false}>
          {t("count", { count: issueCount(run) })}
        </Badge>
      }
    >
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.issue") },
          { label: t("columns.status") },
          { label: t("columns.relation") },
          { label: t("columns.edge") },
          { label: t("columns.view") },
        ]}
      >
        {ref === null ? (
          <tr>
            <td colSpan={5} className={`${cell} text-muted-foreground`}>
              {t("empty")}
            </td>
          </tr>
        ) : (
          <tr data-testid="run-issue-row">
            <td className={cell}>
              <span className={`${mono} block`}>{ref}</span>
              <span
                data-gap="tracker-title"
                className="block text-xs text-muted-foreground"
              >
                {t("titleNotRead")}
              </span>
            </td>
            <td className={`${cell} text-muted-foreground`} data-gap="tracker">
              {t("statusNotRead")}
            </td>
            <td className={cell}>
              <Badge tone="quiet" dot={false}>
                {t("relation.task")}
              </Badge>
            </td>
            <td className={cell}>
              <Badge tone="quiet">{t("edge.stated")}</Badge>
            </td>
            <td className={cell}>
              {url === null ? (
                <span className="text-muted-foreground">{t("noLink")}</span>
              ) : (
                <GitHubLink to={url} className={linkText}>
                  {t("viewLink")}
                </GitHubLink>
              )}
            </td>
          </tr>
        )}
      </Table>
      <p className="pt-3 text-xs text-muted-foreground">{t("note")}</p>
    </Panel>
  );
}

function isFile(node: RunOutputNode) {
  return (node.kind === "file" || node.kind === "change") && node.stat !== null;
}

/**
 * How Oxagen knows a pull request belongs to the run: the collector recorded
 * its receipt or its head commit (observed), or it only shares the branch the
 * run worked on (inferred, and counted as such in the legend).
 */
function PullEdge({ pull }: { pull: RunWorkPull }) {
  const t = useTranslations("run.issues");
  const tw = useTranslations("run.workCi.association");
  return (
    <span title={tw(pull.association)}>
      {pull.association === "branch" ? (
        <Badge tone="denied">{t("edge.inferred")}</Badge>
      ) : (
        <Badge tone="allowed">{t("edge.observed")}</Badge>
      )}
    </span>
  );
}

function LinkedWork({
  read,
  work,
  place,
}: {
  read: Read<RunOutputs>;
  work: Read<RunWork> | null;
  place: Place;
}) {
  const t = useTranslations("run.issues.linked");
  const ti = useTranslations("run.issues");
  const locale = useLocale();
  if (!read.ok) {
    return (
      <Panel title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const evidence = workOf(work);
  const repositories = repositoriesOf(evidence);
  const forgePulls = evidence?.pullRequests ?? [];
  // A pull request the forge answered for replaces the spine's bare name for
  // it; the commits stay, because only the spine records them.
  const artifacts = read.value.nodes.filter(
    (node) =>
      node.kind === "commit" || (node.kind === "pr" && forgePulls.length === 0),
  );
  const files = read.value.nodes.filter(isFile);
  const checkout = checkoutOf(evidence);
  const rows =
    repositories.length + forgePulls.length + artifacts.length + files.length;
  const inferred = forgePulls.filter(
    (pull) => pull.association === "branch",
  ).length;
  const count = (value: number) => formatCount(value, locale);
  const counted = (value: number) => (
    <Badge tone="quiet" dot={false}>
      {count(value)}
    </Badge>
  );
  return (
    <section
      aria-label={t("title")}
      data-testid="run-linked-work"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p className={eyebrow}>{t("title")}</p>
        <p className="flex flex-wrap items-center gap-1.5">
          <Badge tone="allowed">{ti("edge.observed")}</Badge>
          {t("observed")}
        </p>
        <p className="flex flex-wrap items-center gap-1.5">
          <Badge tone="quiet">{ti("edge.stated")}</Badge>
          {t("stated")}
        </p>
        <p className="flex flex-wrap items-center gap-1.5">
          <Badge tone="denied">{ti("edge.inferred")}</Badge>
          {t("inferred", { inferred, total: rows })}
          {read.value.complete ? "" : ` ${t("cut")}`}
        </p>
      </div>
      <Panel title={t("repositories")} aside={counted(repositories.length)}>
        {repositories.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-gap="run-work">
            {t("repositoryNotCaptured")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {repositories.map((repository) => (
              <li
                key={repository.url}
                data-testid="run-linked-repository"
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <ForgeLink
                  url={repository.url}
                  className={`${mono} ${linkText} truncate`}
                >
                  {repository.owner}/{repository.name}
                </ForgeLink>
                <EdgeChip
                  seq={
                    checkout?.repository?.url === repository.url
                      ? checkout.firstSeq
                      : null
                  }
                  place={place}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title={t("artifacts")}
        aside={counted(forgePulls.length + artifacts.length)}
      >
        {forgePulls.length + artifacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noArtifacts")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {forgePulls.map((pull) => (
              <li
                key={pull.url}
                data-testid="run-linked-pr"
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone="quiet" dot={false}>
                    {t("kind.pr")}
                  </Badge>
                  <ForgeLink
                    url={pull.url}
                    className={`${mono} ${linkText} truncate`}
                  >
                    {pullName(pull)}
                  </ForgeLink>
                  <span className="truncate text-muted-foreground">
                    {pull.title}
                  </span>
                </span>
                <PullEdge pull={pull} />
              </li>
            ))}
            {artifacts.map((node) => (
              <li
                key={`${node.seq ?? ""}${node.name}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone="quiet" dot={false}>
                    {t(`kind.${node.kind === "pr" ? "pr" : "commit"}`)}
                  </Badge>
                  <span className={`${mono} truncate`}>{node.name}</span>
                </span>
                <EdgeChip seq={node.seq} place={place} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t("files")} aside={counted(files.length)}>
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noFiles")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {files.map((node) => (
              <li
                key={`${node.seq ?? ""}${node.name}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className={`${mono} min-w-0 truncate`} title={node.name}>
                  {node.name}
                </span>
                <span className="flex items-center gap-3">
                  <span className={`${mono} tabular-nums text-xs`}>
                    <span className="text-success">
                      +{count(node.stat?.added ?? 0)}
                    </span>{" "}
                    <span className="text-error">
                      −{count(node.stat?.removed ?? 0)}
                    </span>
                  </span>
                  <EdgeChip seq={node.seq} place={place} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

export function IssuesSection({
  run,
  outputs,
  work = null,
  place,
  children,
}: {
  run: RunRow;
  outputs: Read<RunOutputs>;
  /** `get_run_work`, settled; null when the page did not read it. */
  work?: Read<RunWork> | null;
  place: Place;
  /** What follows Linked work: the organization's follow-through setting. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <IssuesTable run={run} />
      <LinkedWork read={outputs} work={work} place={place} />
      {children}
    </div>
  );
}
