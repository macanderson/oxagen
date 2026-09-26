// The Issues tab (mockup `issuesTab` then `linkedWork`, pages/run.md, Issues
// tab): every issue the session touched, then the work it linked to, then
// the run's follow-through settings.
//
// The table is `get_run_issues` (#3970, ADR-197), row for row: the task the
// run was started on (stated), the issues its recorded pull requests close,
// and the issues its frames name (observed), each with its status as GitHub
// read it when the page loaded. A status the read could not take says so and
// why, and carries `data-gap="tracker"`, never a guessed state. The table
// appears once; Linked work below it lists repositories, pull requests and
// files, never the issues again.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, Suspense, use } from "react";
import type { RunIssues } from "@/data/contracts/run-issues";
import type { RunOutcomesPolicy } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import {
  RunIssueConnections,
  RunOutcomesConsent,
} from "@/features/run-outcomes";
import { parseGitHubUrl } from "@/shared/github-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { GitHubLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { IssuesTable, type IssueTableRow } from "./issues-table";
import { EdgeChip, LinkedWork, LinkedWorkLoading } from "./linked-work";
import { Note, Panel, PanelBody } from "./parts";
import type { Place, RunTabProps } from "./tab-props";

type Issue = RunIssues["issues"][number];
type Status = NonNullable<Issue["status"]>;
type Unread = Exclude<Issue["statusRead"], "read">;

/** The dot and word a read status draws in. */
const STATUS_TONE: Record<Status, BadgeTone> = {
  open: "allowed",
  in_progress: "approval",
  blocked: "failed",
  closed: "quiet",
};

/**
 * The Issues tab's count in the tab strip: the rows the table draws. When a
 * limit cut the list, or the read failed, the count is a floor.
 */
export function IssuesCount({
  run,
  issues,
}: {
  run: RunRow;
  issues: Promise<Read<RunIssues>>;
}) {
  const t = useTranslations("run.tabs");
  const read = use(issues);
  if (!read.ok) return t("atLeast", { count: run.taskRef === null ? 0 : 1 });
  const count = read.value.issues.length;
  return read.value.complete ? String(count) : t("atLeast", { count });
}

function ViewLink({ issue }: { issue: Issue }) {
  const t = useTranslations("run.issues");
  const target = parseGitHubUrl(issue.url);
  if (target === null)
    return <span className="text-[11.5px] text-dim">{t("noLink")}</span>;
  return (
    <GitHubLink
      to={target}
      aria-label={t("viewLabel", { ref: issue.ref })}
      className="whitespace-nowrap text-link hover:underline"
    >
      {t("view")}
    </GitHubLink>
  );
}

/** The status as a dot and a word, or why none was read. */
function StatusCell({ issue }: { issue: Issue }) {
  const t = useTranslations("run.issues");
  const format = useFormatter();
  if (issue.statusRead === "read" && issue.status !== null)
    return (
      <span
        title={
          issue.readAt === null
            ? undefined
            : t("stateAt", {
                at: format.dateTime(new Date(issue.readAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })
        }
      >
        <Badge tone={STATUS_TONE[issue.status]} dot>
          {t(`state.${issue.status}`)}
        </Badge>
      </span>
    );
  const why: Unread =
    issue.statusRead === "read" ? "read_failed" : issue.statusRead;
  return (
    <span
      data-gap="tracker"
      data-status-read={issue.statusRead}
      title={t(`statusRead.${why}`)}
      className="text-muted-foreground"
    >
      {t("statusUnknown")}
    </span>
  );
}

function RelationCell({ issue }: { issue: Issue }) {
  const t = useTranslations("run.issues");
  const label =
    issue.relation === "task"
      ? t("task")
      : issue.relation === "resolves" && issue.resolvedBy.length > 0
        ? t("closedBy", {
            number: issue.resolvedBy
              .map((pull) => String(pull.number))
              .join(", #"),
          })
        : t("referenced");
  return (
    <Badge tone="quiet" dot={false}>
      {label}
    </Badge>
  );
}

function issueRow(issue: Issue, place: Place): IssueTableRow {
  return {
    key: issue.ref,
    status: issue.statusRead === "read" ? issue.status : null,
    cells: [
      <span key="ref" className="flex min-w-0 flex-col">
        <span className={`${mono} text-xs`}>{issue.ref}</span>
        {issue.title === null ? null : (
          <span className="truncate text-[11.5px] text-muted-foreground">
            {issue.title}
          </span>
        )}
      </span>,
      <StatusCell key="status" issue={issue} />,
      <RelationCell key="relation" issue={issue} />,
      <EdgeChip
        key="edge"
        edge={issue.edge}
        frames={issue.frameSeqs}
        place={place}
      />,
      <ViewLink key="view" issue={issue} />,
    ],
  };
}

/**
 * The Issues table. `read` is `get_run_issues`; null while it is still being
 * read, so the panel draws at once and the rows join it when GitHub answers.
 */
function IssuesPanel({
  place,
  read,
}: {
  place: Place;
  read: Read<RunIssues> | null;
}) {
  const t = useTranslations("run.issues");
  const locale = useLocale();
  const answer = read?.ok === true ? read.value : null;
  const rows = (answer?.issues ?? []).map((issue) => issueRow(issue, place));
  const complete = answer?.complete ?? true;
  const count = formatCount(rows.length, locale);
  return (
    <Panel
      title={t("title")}
      aside={
        answer === null ? undefined : (
          <Badge tone="quiet" dot={false}>
            {complete ? t("count", { count }) : t("countAtLeast", { count })}
          </Badge>
        )
      }
      flush
      testId="run-issues"
    >
      {read === null ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </PanelBody>
      ) : !read.ok ? (
        <PanelBody>
          <ReadFailure read={read} section={t("title")} />
        </PanelBody>
      ) : rows.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">
            {complete ? t("empty") : t("emptyIncomplete")}
          </p>
        </PanelBody>
      ) : (
        <>
          <IssuesTable
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
          {complete ? null : (
            <PanelBody rule>
              <Note testId="run-issues-incomplete">{t("incomplete")}</Note>
            </PanelBody>
          )}
        </>
      )}
    </Panel>
  );
}

/** The Issues table once the issues read answers. */
function IssuesFromRead({
  place,
  issues,
}: {
  place: Place;
  issues: Promise<Read<RunIssues>>;
}) {
  return <IssuesPanel place={place} read={use(issues)} />;
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
 * organization's follow-through setting, and leaves the issues and work
 * reads to stream inside the Issues table's and Linked work's boundaries.
 */
export async function IssuesTab(props: RunTabProps): Promise<ReactNode> {
  const { ctx, source, place, work, issues, outputs } = props;
  const outcomes = await source.runs
    .outcomesSettings(ctx)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  const canManage = ctx.orgRole === "owner" || ctx.orgRole === "admin";
  return (
    <>
      <Suspense fallback={<IssuesPanel place={place} read={null} />}>
        <IssuesFromRead place={place} issues={issues} />
      </Suspense>
      <Suspense fallback={<LinkedWorkLoading />}>
        <LinkedWork work={work} outputs={outputs} place={place} />
      </Suspense>
      <FollowThrough outcomes={outcomes} place={place} canManage={canManage} />
    </>
  );
}
