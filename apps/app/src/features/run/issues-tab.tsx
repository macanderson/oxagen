// The Issues tab (mockup `issuesTab` then `linkedWork`, pages/run.md, Issues
// tab): every issue the session touched, then the work it linked to, then
// the run's follow-through settings.
//
// The record keeps one issue per run, the task reference the run was started
// on, and nothing records its status: no tracker read is made for this page.
// So the table lists that one task, says its status is not recorded, and the
// note under it says what the record does not capture. The table appears once;
// Linked work below it lists repositories, pull requests and files, never the
// issues again.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, Suspense } from "react";
import type { RunOutcomesPolicy } from "@/data/contracts/run-work";
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

function ViewLink({ refName }: { refName: string }) {
  const t = useTranslations("run.issues");
  const target = issueUrl(refName);
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

function IssuesPanel({ run, place }: { run: RunRow; place: Place }) {
  const t = useTranslations("run.issues");
  const locale = useLocale();
  const refs = run.taskRef === null ? [] : [run.taskRef];
  const rows: ListRow[] = refs.map((ref) => ({
    key: ref,
    data: { "data-testid": "run-issue" },
    cells: [
      <span key="ref" className={`${mono} text-xs`}>
        {ref}
      </span>,
      <span key="status" title={t("statusWhy")}>
        <NoValue />
      </span>,
      <Badge key="relation" tone="quiet" dot={false}>
        {t("task")}
      </Badge>,
      <EdgeChip key="edge" edge="stated" place={place} />,
      <ViewLink key="view" refName={ref} />,
    ],
  }));
  return (
    <Panel
      title={t("title")}
      aside={
        <Badge tone="quiet" dot={false}>
          {t("count", { count: formatCount(refs.length, locale) })}
        </Badge>
      }
      flush
      testId="run-issues"
    >
      {rows.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
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
        <Note>{t("note")}</Note>
      </PanelBody>
    </Panel>
  );
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
 * inside Linked work's boundary.
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
      <IssuesPanel run={run} place={place} />
      <Suspense fallback={<LinkedWorkLoading />}>
        <LinkedWork work={work} outputs={outputs} place={place} />
      </Suspense>
      <FollowThrough outcomes={outcomes} place={place} canManage={canManage} />
    </>
  );
}
