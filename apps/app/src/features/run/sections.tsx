// Three of the Run page's tabs (spec pages/run.md): Issues, Policy and
// Context. Policy and Context each read the run's transcript narrowed to their
// own chip, page by page to the end (`readWholeTranscript`), and list the
// entries that carry a policy decision or a recall. A list that stops short of
// the end (`isWhole`) says it is a prefix; a failed read says it failed.
import { useLocale, useTranslations } from "next-intl";
import { Suspense, use } from "react";
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import type { RunWork as RunWorkView } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { parseGitHubUrl } from "@/shared/github-url";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { formatDuration } from "@/ui/money-format";
import { GitHubLink, SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Panel } from "./parts";
import { entryKey } from "./transcript-model";
import { isWhole } from "./whole-transcript";

type Place = { org: string; ws: string; runId: string };

/** The entries of a whole-run transcript that answer to one chip. */
export function entriesOf(
  read: Read<RunTranscript>,
  kind: "policy" | "recall",
): TranscriptEntry[] | null {
  return read.ok
    ? read.value.entries.filter((entry) => entry.kinds.includes(kind))
    : null;
}

/** An issue a pull request the run opened closes, by GitHub's own record. */
type ClosingIssue = { key: string; label: string; url: string; pr: number };

/**
 * The issues the run's own pull requests close. Only a pull request the run
 * recorded opening counts. A pull request matched by head commit or by branch
 * name is a guess about the task, and this list holds facts (#4024). `unread`
 * is true when GitHub's list for any of those pull requests is missing or cut
 * short, so an unread list never reads as closing nothing.
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
      const label = `${issue.owner}/${issue.repo}#${issue.number}`;
      if (!issues.has(label))
        issues.set(label, { key: label, label, url: issue.url, pr: pr.number });
    }
  }
  return { issues: [...issues.values()], unread };
}

/**
 * The Issues tab's list: the task reference the run was started on, then the
 * issues its recorded pull requests close. `read` is null while the pull
 * requests are still being read.
 *
 * @internal Exported for its unit test; the page renders it through
 * IssuesSection.
 */
export function IssuesList({
  taskRef,
  read,
}: {
  taskRef: string | null;
  read: Read<RunWorkView> | null;
}) {
  const t = useTranslations("run.issues");
  const closing = read?.ok ? closingIssuesOf(read.value) : null;
  const rows = closing?.issues ?? [];
  const empty = taskRef === null && closing !== null && rows.length === 0;
  return (
    <>
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {closing.unread ? t("emptyUnread") : t("empty")}
        </p>
      ) : null}
      {taskRef === null && rows.length === 0 ? null : (
        <Table
          label={t("title")}
          columns={[{ label: t("reference") }, { label: t("relation") }]}
        >
          {taskRef === null ? null : (
            <tr>
              <td className={`${cell} ${mono}`}>{taskRef}</td>
              <td className={cell}>{t("task")}</td>
            </tr>
          )}
          {rows.map((issue) => {
            const url = parseGitHubUrl(issue.url);
            return (
              <tr key={issue.key}>
                <td className={`${cell} ${mono}`}>
                  {url === null ? (
                    issue.label
                  ) : (
                    <GitHubLink
                      to={url}
                      className="underline underline-offset-4"
                    >
                      {issue.label}
                    </GitHubLink>
                  )}
                </td>
                <td className={cell}>
                  {t("closedBy", { number: issue.pr })}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      {read === null ? (
        <p className="pt-3 text-xs text-muted-foreground">{t("loading")}</p>
      ) : !read.ok ? (
        <ReadFailure read={read} section={t("pullRequests")} />
      ) : closing?.unread && !empty ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {t("closingUnread")}
        </p>
      ) : null}
    </>
  );
}

function ClosingIssuesRead({
  taskRef,
  work,
}: {
  taskRef: string | null;
  work: Promise<Read<RunWorkView>>;
}) {
  return <IssuesList taskRef={taskRef} read={use(work)} />;
}

/**
 * The page starts the run's work read once and hands both this tab and the
 * work section the same promise, so GitHub latency streams inside this
 * boundary and does not hold the page.
 */
export function IssuesSection({
  run,
  work,
}: {
  run: RunRow;
  work: Promise<Read<RunWorkView>>;
}) {
  const t = useTranslations("run.issues");
  return (
    <Panel title={t("title")}>
      <Suspense fallback={<IssuesList taskRef={run.taskRef} read={null} />}>
        <ClosingIssuesRead taskRef={run.taskRef} work={work} />
      </Suspense>
      <p className="pt-3 text-xs text-muted-foreground">{t("note")}</p>
    </Panel>
  );
}

function FrameLink({
  seq,
  chainRef,
  place,
}: {
  seq: string;
  /** Set for a subagent's frame, which the Frames tab cannot open by seq. */
  chainRef: string | undefined;
  place: Place;
}) {
  // The Frames tab reads the run's own chain. A subagent's frame shares its
  // seq with a different frame there, so it is named and not linked.
  if (chainRef !== undefined)
    return <span className={`${mono} text-muted-foreground`}>{seq}</span>;
  return (
    <SafeLink
      to={routes.run(place.org, place.ws, place.runId, {
        tab: "actions",
        body: seq,
      })}
      className={`${mono} text-muted-foreground hover:text-foreground`}
    >
      {seq}
    </SafeLink>
  );
}

function outcomeTone(decision: string) {
  if (decision === "allow") return "allowed" as const;
  if (decision === "deny") return "denied" as const;
  if (decision === "ask" || decision === "approval") return "approval" as const;
  return "quiet" as const;
}

export function PolicySection({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.policy");
  const locale = useLocale();
  const entries = entriesOf(read, "policy");
  if (entries === null || !read.ok) {
    return (
      <Panel title={t("title")}>
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  }
  return (
    <Panel title={t("title")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("frame") },
            { label: t("call") },
            { label: t("outcome") },
            { label: t("type") },
            { label: t("at"), numeric: true },
          ]}
        >
          {entries.map((entry) => (
            <tr key={entryKey(entry)}>
              <td className={cell}>
                <FrameLink
                  seq={entry.decision?.seq ?? entry.seq}
                  chainRef={
                    entry.decision === null
                      ? entry.subagent?.chainRef
                      : entry.decision.chainRef
                  }
                  place={place}
                />
              </td>
              <td className={`${cell} ${mono}`}>{entry.label}</td>
              <td className={cell}>
                {entry.decision === null ? null : (
                  <Badge tone={outcomeTone(entry.decision.decision)}>
                    {entry.decision.decision}
                  </Badge>
                )}
              </td>
              <td className={`${cell} ${mono}`}>
                {entry.decision?.type ?? entry.type}
              </td>
              <td className={`${cell} text-right tabular-nums`}>
                {formatDuration(entry.elapsedMs, locale)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {isWhole(read.value) ? null : (
        <p className="pt-3 text-xs text-muted-foreground">{t("cut")}</p>
      )}
    </Panel>
  );
}

export function ContextSection({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.context");
  const locale = useLocale();
  const entries = entriesOf(read, "recall");
  if (entries === null || !read.ok) {
    return (
      <Panel title={t("title")}>
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  }
  return (
    <Panel title={t("title")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("frame") },
            { label: t("what") },
            { label: t("at"), numeric: true },
          ]}
        >
          {entries.map((entry) => (
            <tr key={entryKey(entry)}>
              <td className={cell}>
                <FrameLink
                  seq={entry.seq}
                  chainRef={entry.subagent?.chainRef}
                  place={place}
                />
              </td>
              <td className={`${cell} ${mono}`}>{entry.label}</td>
              <td className={`${cell} text-right tabular-nums`}>
                {formatDuration(entry.elapsedMs, locale)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {isWhole(read.value) ? null : (
        <p className="pt-3 text-xs text-muted-foreground">{t("cut")}</p>
      )}
    </Panel>
  );
}
