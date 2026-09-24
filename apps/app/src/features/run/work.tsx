// The side column's first panel (mockup `runSide`, pages/run.md, Side
// column): Changes. The pull requests the run pushed to with their state,
// the base, the checks, the diff, and one row per changed file.
//
// It reads the same work read the header's checkout strip does, so the strip,
// this panel and the Issues tab's Linked work cannot name a different pull
// request. The files are the ones the outputs recorded with a line stat. A
// fact neither read carries (the base branch, a release) reads as not
// recorded or is left out, never guessed.
import { useLocale, useTranslations } from "next-intl";
import { use } from "react";
import type { RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { parseGitHubUrl } from "@/shared/github-url";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { buttonSecondary, kvTerm, kvValue } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { GitHubLink, SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";
import type { Place } from "./tab-props";

/** How many changed files the panel lists before it says how many more. */
const FILE_ROWS = 8;

type Pull = RunWork["pullRequests"][number];
type CiOverall = NonNullable<Pull["ci"]>["overall"];

/** `artState`: a check's or a pull request's state as its pill. */
const CI_TONE: Record<CiOverall, BadgeTone> = {
  passing: "allowed",
  failing: "failed",
  pending: "approval",
  neutral: "quiet",
  unknown: "quiet",
};
const PR_TONE: Record<Pull["state"], BadgeTone> = {
  open: "approval",
  merged: "allowed",
  closed: "quiet",
};

/** One file the run changed, with a stat the record carries. */
export function isFileChange(node: RunOutputNode) {
  return (node.kind === "file" || node.kind === "change") && node.stat !== null;
}

/** The whole set's state: failing wins over pending, which wins over passing. */
function ciOf(pulls: readonly Pull[]): CiOverall | null {
  const states = pulls.flatMap((pr) => (pr.ci === null ? [] : [pr.ci.overall]));
  if (states.length === 0) return null;
  for (const state of ["failing", "pending", "passing", "neutral"] as const)
    if (states.includes(state)) return state;
  return "unknown";
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className={`${kvTerm} text-[11px]`}>{label}</dt>
      <dd className={`${kvValue} text-xs`}>{children}</dd>
    </>
  );
}

function Stat({ added, removed }: { added: number; removed: number }) {
  const locale = useLocale();
  return (
    <span className="whitespace-nowrap font-mono">
      <b className="text-success">+{formatCount(added, locale)}</b>{" "}
      <b className="text-warning">−{formatCount(removed, locale)}</b>
    </span>
  );
}

function ChangesBody({
  work,
  outputs,
  run,
  place,
}: {
  work: Read<RunWork>;
  outputs: Read<RunOutputs>;
  run: RunRow;
  place: Place;
}) {
  const t = useTranslations("run.work");
  const pulls = work.ok ? work.value.pullRequests : [];
  const ci = ciOf(pulls);
  const files = outputs.ok ? outputs.value.nodes.filter(isFileChange) : [];
  const added = files.reduce((sum, node) => sum + (node.stat?.added ?? 0), 0);
  const removed = files.reduce(
    (sum, node) => sum + (node.stat?.removed ?? 0),
    0,
  );
  const head =
    ci !== null ? (
      <Badge tone={CI_TONE[ci]}>{t(`ci.${ci}`)}</Badge>
    ) : pulls[0] !== undefined ? (
      <Badge tone={PR_TONE[pulls[0].state]}>{t(`pr.${pulls[0].state}`)}</Badge>
    ) : undefined;
  return (
    <Panel title={t("changes")} aside={head} testId="run-changes">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px]">
        <Row label={t("pullRequest")}>
          {!work.ok ? (
            <ReadFailure read={work} section={t("pullRequest")} />
          ) : pulls.length === 0 ? (
            <span className="text-dim">
              {run.status === "live"
                ? t("noPullRequestLive")
                : t("noPullRequest")}
            </span>
          ) : (
            <span className="flex flex-col gap-1">
              {pulls.map((pr) => {
                const target = parseGitHubUrl(pr.url);
                const name = `${pr.repository.owner}/${pr.repository.name}#${String(pr.number)}`;
                return (
                  <span
                    key={`${pr.repository.url}/${String(pr.number)}`}
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    {target === null ? (
                      <span className="font-mono">{name}</span>
                    ) : (
                      <GitHubLink
                        to={target}
                        title={pr.title}
                        className="font-mono text-link hover:underline"
                      >
                        {name}
                      </GitHubLink>
                    )}
                    <Badge tone={PR_TONE[pr.state]}>
                      {t(`pr.${pr.state}`)}
                    </Badge>
                  </span>
                );
              })}
            </span>
          )}
        </Row>
        <Row label={t("base")}>
          <span className="text-dim">{t("baseNotRecorded")}</span>
        </Row>
        <Row label={t("checks")}>
          {ci === null ? (
            <span className="text-dim">{t("noChecks")}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={CI_TONE[ci]}>{t(`ci.${ci}`)}</Badge>
              <span className="text-dim">
                {pulls
                  .flatMap((pr) => pr.ci?.runs ?? [])
                  .map((check) =>
                    t("check", {
                      name: check.name,
                      state: check.conclusion ?? check.status,
                    }),
                  )
                  .join(", ")}
              </span>
            </span>
          )}
        </Row>
        <Row label={t("diff")}>
          {!outputs.ok ? (
            <ReadFailure read={outputs} section={t("diff")} />
          ) : files.length === 0 ? (
            <span className="text-dim">{t("noDiff")}</span>
          ) : (
            <span>
              <Stat added={added} removed={removed} />{" "}
              <span className="text-dim">
                {t("inFiles", { count: files.length })}
                {outputs.value.complete ? "" : "+"}
              </span>
            </span>
          )}
        </Row>
      </dl>
      {files.length === 0 ? null : (
        <>
          <ul
            data-testid="run-changed-files"
            className="mt-2 border-t border-border"
          >
            {files.slice(0, FILE_ROWS).map((node) => (
              <li
                key={`${node.seq ?? ""}${node.name}`}
                className="flex min-w-0 justify-between gap-2.5 border-b border-border py-[5px] text-[11.5px]"
              >
                <span className="min-w-0 truncate font-mono" title={node.name}>
                  {node.name}
                </span>
                <Stat
                  added={node.stat?.added ?? 0}
                  removed={node.stat?.removed ?? 0}
                />
              </li>
            ))}
            {files.length > FILE_ROWS ? (
              <li className="py-[5px] text-[11.5px] text-dim">
                {t("more", { count: files.length - FILE_ROWS })}
              </li>
            ) : null}
          </ul>
          <div className="mt-2 flex">
            <SafeLink
              to={routes.run(place.org, place.ws, place.runId, {
                tab: "transcript",
                kinds: "tools",
              })}
              className={`${buttonSecondary} min-h-7 px-2.5 text-xs`}
            >
              {t("openDiff")}
            </SafeLink>
          </div>
        </>
      )}
    </Panel>
  );
}

/** The panel, once the work read the page started has answered. */
export function ChangesPanel({
  work,
  ...rest
}: {
  work: Promise<Read<RunWork>>;
  outputs: Read<RunOutputs>;
  run: RunRow;
  place: Place;
}) {
  return <ChangesBody work={use(work)} {...rest} />;
}

export function ChangesLoading() {
  const t = useTranslations("run.work");
  return (
    <Panel title={t("changes")}>
      <p
        role="status"
        aria-busy="true"
        className="text-xs text-muted-foreground"
      >
        {t("loading")}
      </p>
    </Panel>
  );
}
