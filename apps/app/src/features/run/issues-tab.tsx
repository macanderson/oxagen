// The Issues tab (mockup `issuesTab` then `linkedWork`, pages/run.md, Issues
// tab): every issue the session touched, then the work it linked to, then
// the run's follow-through settings.
//
// Two sources name an issue. The run's task reference is the one it was
// started on, and no tracker read gives its status. The issues each pull
// request the run opened closes come from GitHub's own record (#4024, #4029),
// with GitHub's state. A pull request matched by head commit or branch name
// adds nothing, because it does not show the run opened it. The table appears
// once; Linked work below it lists repositories, pull requests and files,
// never the issues again.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, Suspense, use } from "react";
import type {
  RunOutcomesPolicy,
  RunWork as RunWorkView,
} from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import {
  RunIssueConnections,
  RunOutcomesConsent,
} from "@/features/run-outcomes";
import { type GitHubUrl, parseGitHubUrl } from "@/shared/github-url";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { formatCount } from "@/ui/money-format";
import { GitHubLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { EdgeChip, LinkedWork, LinkedWorkLoading } from "./linked-work";
import { Note, NoValue, Panel, PanelBody } from "./parts";
import type { Place, RunTabProps } from "./tab-props";

/**
 * The tracker page a task reference names, when Oxagen can name it: a
 * GitHub issue written `owner/repo#N`, or a GitHub URL. A reference in any
 * other tracker's shape (`ENG-4121`) carries no host, so it is not linked.
 *
 * @internal Exported for its unit test; the tab calls it through ViewLink.
 */
export function issueUrl(ref: string): GitHubUrl | null {
  const github = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref);
  if (github !== null) {
    const [, owner = "", repo = "", n = ""] = github;
    return parseGitHubUrl(`https://github.com/${owner}/${repo}/issues/${n}`);
  }
  return parseGitHubUrl(ref);
}

/** An issue a pull request the run opened closes, by GitHub's own record. */
type ClosingIssue = {
  ref: string;
  url: string;
  state: "open" | "closed";
  pr: number;
};

/**
 * The issues the run's own pull requests close. Only a pull request the run
 * recorded opening counts. `unread` is true when GitHub's list for any of
 * those pull requests is missing or cut short, so an unread list never reads
 * as closing nothing.
 *
 * @internal Exported for its unit test; the panel calls it.
 */
export function closingIssuesOf(work: RunWorkView): {
  issues: ClosingIssue[];
  unread: boolean;
} {
  const issues = new Map<string, ClosingIssue>();
  let unread = false;
  for (const pr of work.pullRequests) {
    if (pr.association !== "recorded") continue;
    if (pr.closingIssues === null) {
      unread = true;
      continue;
    }
    if (!pr.closingIssues.complete) unread = true;
    for (const issue of pr.closingIssues.issues) {
      const ref = `${issue.owner}/${issue.repo}#${String(issue.number)}`;
      if (!issues.has(ref))
        issues.set(ref, {
          ref,
          url: issue.url,
          state: issue.state,
          pr: pr.number,
        });
    }
  }
  return { issues: [...issues.values()], unread };
}

/** The closing issues the table adds under the task: every one but the task itself. */
function beyondTask(
  run: RunRow,
  closing: { issues: ClosingIssue[] } | null,
): ClosingIssue[] {
  return (closing?.issues ?? []).filter((issue) => issue.ref !== run.taskRef);
}

/**
 * The Issues tab's count in the tab strip: the rows the table draws. When
 * GitHub did not return every closing list, or the pull requests could not
 * be read, the count is a floor.
 */
export function IssuesCount({
  run,
  work,
}: {
  run: RunRow;
  work: Promise<Read<RunWorkView>>;
}) {
  const t = useTranslations("run.tabs");
  const read = use(work);
  const closing = read.ok ? closingIssuesOf(read.value) : null;
  const count =
    (run.taskRef === null ? 0 : 1) + beyondTask(run, closing).length;
  return closing === null || closing.unread
    ? t("atLeast", { count })
    : String(count);
}

function ViewLink({ refName, url }: { refName: string; url?: string }) {
  const t = useTranslations("run.issues");
  const target = url === undefined ? issueUrl(refName) : parseGitHubUrl(url);
  if (target === null)
    return <span className="text-[11.5px] text-dim">{t("noLink")}</span>;
  return (
    <GitHubLink
      to={target}
      aria-label={t("viewLabel", { ref: refName })}
      className="whitespace-nowrap text-link hover:underline"
    >
      {t("view")}
    </GitHubLink>
  );
}

/**
 * The Issues table. `read` is the run's work read, which carries the pull
 * requests; null while it is still being read, so the task row draws at once
 * and the closing issues join it when GitHub answers.
 */
function IssuesPanel({
  run,
  place,
  read,
}: {
  run: RunRow;
  place: Place;
  read: Read<RunWorkView> | null;
}) {
  const t = useTranslations("run.issues");
  const locale = useLocale();
  const closing = read?.ok === true ? closingIssuesOf(read.value) : null;
  const task: ListRow[] =
    run.taskRef === null
      ? []
      : [
          {
            key: run.taskRef,
            data: { "data-testid": "run-issue" },
            cells: [
              <span key="ref" className={`${mono} text-xs`}>
                {run.taskRef}
              </span>,
              <span key="status" title={t("statusWhy")}>
                <NoValue />
              </span>,
              <Badge key="relation" tone="quiet" dot={false}>
                {t("task")}
              </Badge>,
              <EdgeChip key="edge" edge="stated" place={place} />,
              <ViewLink key="view" refName={run.taskRef} />,
            ],
          },
        ];
  const closed: ListRow[] = beyondTask(run, closing).map((issue) => ({
    key: issue.ref,
    data: { "data-testid": "run-issue" },
    cells: [
      <span key="ref" className={`${mono} text-xs`}>
        {issue.ref}
      </span>,
      <span key="status" title={t("stateWhy")}>
        <Badge tone={issue.state === "open" ? "allowed" : "quiet"} dot>
          {t(`state.${issue.state}`)}
        </Badge>
      </span>,
      <Badge key="relation" tone="quiet" dot={false}>
        {t("closedBy", { number: String(issue.pr) })}
      </Badge>,
      <EdgeChip key="edge" edge="observed" place={place} />,
      <ViewLink key="view" refName={issue.ref} url={issue.url} />,
    ],
  }));
  const rows = [...task, ...closed];
  return (
    <Panel
      title={t("title")}
      aside={
        <Badge tone="quiet" dot={false}>
          {t("count", { count: formatCount(rows.length, locale) })}
        </Badge>
      }
      flush
      testId="run-issues"
    >
      {rows.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">
            {read === null
              ? t("loading")
              : closing?.unread === true
                ? t("emptyUnread")
                : t("empty")}
          </p>
        </PanelBody>
      ) : (
        <ListTable
          label={t("title")}
          columns={[
            { label: t("issue") },
            { label: t("status") },
            { label: t("relation") },
            { label: t("edge") },
            { label: t("viewColumn"), hidden: true },
          ]}
          rows={rows}
        />
      )}
      <PanelBody rule={rows.length > 0}>
        {read === null && rows.length > 0 ? (
          <Note>{t("loading")}</Note>
        ) : read !== null && !read.ok ? (
          <ReadFailure read={read} section={t("pullRequests")} />
        ) : closing?.unread === true && rows.length > 0 ? (
          <Note>{t("closingUnread")}</Note>
        ) : null}
        <Note>{t("note")}</Note>
      </PanelBody>
    </Panel>
  );
}

/** The Issues table once the work read answers. */
function IssuesFromWork({
  run,
  place,
  work,
}: {
  run: RunRow;
  place: Place;
  work: Promise<Read<RunWorkView>>;
}) {
  return <IssuesPanel run={run} place={place} read={use(work)} />;
}

/** The run follow-through panels, which the page drew above its columns before the tabs owned them. */
function FollowThrough({
  outcomes,
  place,
  canManage,
}: {
  outcomes: Read<RunOutcomesPolicy>;
  place: Place;
  canManage: boolean;
}) {
  const at = { org: place.org, ws: place.ws };
  return (
    <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
      <RunOutcomesConsent at={at} policy={outcomes} canManage={canManage} />
      <RunIssueConnections
        at={at}
        runId={place.runId}
        enabled={outcomes.ok && outcomes.value.effectiveEnabled}
        canManage={canManage}
      />
    </div>
  );
}

/**
 * The Issues tab over the page's bundle. It makes one read of its own, the
 * organization's follow-through setting, and leaves the work read to stream
 * inside the Issues table's and Linked work's boundaries.
 */
export async function IssuesTab(props: RunTabProps): Promise<ReactNode> {
  const { ctx, source, run, place, work, outputs } = props;
  const outcomes = await source.runs
    .outcomesSettings(ctx)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  const canManage = ctx.orgRole === "owner" || ctx.orgRole === "admin";
  return (
    <>
      <Suspense fallback={<IssuesPanel run={run} place={place} read={null} />}>
        <IssuesFromWork run={run} place={place} work={work} />
      </Suspense>
      <Suspense fallback={<LinkedWorkLoading />}>
        <LinkedWork work={work} outputs={outputs} place={place} />
      </Suspense>
      <FollowThrough outcomes={outcomes} place={place} canManage={canManage} />
    </>
  );
}
