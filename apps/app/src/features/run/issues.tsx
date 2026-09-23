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
// Linked work reads the outputs spine the page already holds: the pull
// requests and commits the frames recorded, and the files they changed, each
// with the frame that recorded it. The repository is not on the run record,
// so its panel says so rather than guessing one from a branch name.
import { useLocale, useTranslations } from "next-intl";
import type { RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { eyebrow, linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Panel } from "./parts";

type Place = { org: string; ws: string; runId: string };

const GITHUB_ISSUE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** The tracker page for a reference, when its shape names one. */
export function issueUrl(ref: string): string | null {
  const match = GITHUB_ISSUE.exec(ref.trim());
  if (match === null) return null;
  const [, owner, repo, number] = match;
  return `https://github.com/${owner}/${repo}/issues/${number}`;
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

function IssuesTable({ run }: { run: RunRow }) {
  const t = useTranslations("run.issues");
  const ref = run.taskRef;
  const url = ref === null ? null : issueUrl(ref);
  return (
    <Panel
      title={t("title")}
      aside={
        <Badge tone="quiet" dot={false}>
          {t("count", { count: ref === null ? 0 : 1 })}
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
            <td className={`${cell} ${mono}`}>{ref}</td>
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
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkText}
                >
                  {t("viewLink")}
                </a>
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

function LinkedWork({ read, place }: { read: Read<RunOutputs>; place: Place }) {
  const t = useTranslations("run.issues.linked");
  const locale = useLocale();
  if (!read.ok) {
    return (
      <Panel title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const work = read.value.nodes.filter(
    (node) => node.kind === "pr" || node.kind === "commit",
  );
  const files = read.value.nodes.filter(isFile);
  const rows = work.length + files.length;
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
        <p>{t("observed")}</p>
        <p>{t("stated")}</p>
        <p>
          {t("inferred", { inferred: 0, total: rows })}
          {read.value.complete ? "" : ` ${t("cut")}`}
        </p>
      </div>
      <Panel title={t("repositories")} aside={counted(0)}>
        <p className="text-sm text-muted-foreground" data-gap="run-work">
          {t("repositoryNotCaptured")}
        </p>
      </Panel>
      <Panel title={t("artifacts")} aside={counted(work.length)}>
        {work.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noArtifacts")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {work.map((node) => (
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
  place,
}: {
  run: RunRow;
  outputs: Read<RunOutputs>;
  place: Place;
}) {
  return (
    <div className="flex flex-col gap-4">
      <IssuesTable run={run} />
      <LinkedWork read={outputs} place={place} />
    </div>
  );
}
