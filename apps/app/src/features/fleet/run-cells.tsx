"use client";
// The Fleet runs table's summary, pull request and lines-changed cells, moved
// out of board.tsx unchanged to keep that file under 1,500 lines.
import { GitPullRequest } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { RunDiff, RunPullRequest, RunRow } from "@/data/contracts/runs";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { PullRequestLink } from "@/ui/navigation";
import { forgeOf, pullRequestLabel } from "./view";

/**
 * The generated summary, two lines at most with the whole text on hover. A
 * workspace that turned summaries off reads so, rather than "none yet".
 */
export function SummaryCell({ run }: { run: RunRow }) {
  const t = useTranslations("fleet.runs");
  const off = run.enrichmentEnabled === false;
  const summary = off ? null : run.summary;
  if (summary === null)
    return (
      <span className="text-muted-foreground">
        {off ? t("summaryOff") : t("summaryNone")}
      </span>
    );
  return (
    <p
      data-testid="row-summary"
      title={summary.text}
      className="line-clamp-2 text-[12px] leading-snug text-muted-foreground"
    >
      {summary.text}
    </p>
  );
}

/** The tone a recorded pull-request state reads in; the Run page uses the same ladder. */
const PR_STATE_TONE: Record<NonNullable<RunPullRequest["state"]>, BadgeTone> = {
  open: "approval",
  draft: "quiet",
  merged: "allowed",
  closed: "quiet",
};

/**
 * One pull request: a link that opens it on GitHub or GitLab in a new tab
 * when the URL names a page Oxagen recognises, else its label alone, and its
 * state. No store records the state yet, so it reads "status unknown" and
 * says on hover where the live state is.
 */
function PullRequestItem({ pull }: { pull: RunPullRequest }) {
  const t = useTranslations("fleet.runs.prs");
  const url = parsePullRequestUrl(pull.url);
  const label = pullRequestLabel(pull) ?? t("unnamed");
  const forge = forgeOf(pull.url);
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {url === null ? (
        <span className={`${mono} text-[11.5px]`} title={pull.url}>
          {label}
        </span>
      ) : (
        <PullRequestLink
          to={url}
          data-testid="row-pr-link"
          data-forge={forge ?? undefined}
          data-touch-target=""
          aria-label={
            forge === "gitlab"
              ? t("openOnGitLab", { pr: label })
              : t("openOnGitHub", { pr: label })
          }
          onClick={(event) => {
            event.stopPropagation();
          }}
          className={`${linkText} inline-flex items-center gap-1 whitespace-nowrap font-mono text-[11.5px]`}
        >
          <GitPullRequest aria-hidden className="size-3 flex-none" />
          {label}
        </PullRequestLink>
      )}
      {pull.state === null ? (
        <span
          data-testid="row-pr-state"
          data-state="unknown"
          title={t("stateUnknownHint")}
          className="whitespace-nowrap text-[10.5px] text-muted-foreground"
        >
          {t("stateUnknown")}
        </span>
      ) : (
        <Badge
          tone={PR_STATE_TONE[pull.state]}
          data-testid="row-pr-state"
          data-state={pull.state}
        >
          {t(`state.${pull.state}`)}
        </Badge>
      )}
    </li>
  );
}

/** The most pull requests a row lists before it says how many more there are. */
const PRS_SHOWN = 2;

export function PullRequestsCell({ run }: { run: RunRow }) {
  const t = useTranslations("fleet.runs.prs");
  const pulls = run.pullRequests;
  const opened = run.pullRequestsOpened ?? 0;
  if (pulls === undefined) {
    // Not read: a ledger run's pull requests are receipts the Run page reads,
    // and a wrapped session's read failed (the panel says so above the table).
    if (run.source === "ledger")
      return (
        <span
          data-testid="row-prs-elsewhere"
          title={t("ledgerHint")}
          className="text-muted-foreground"
        >
          {t("onRunPage")}
        </span>
      );
    return (
      <span data-testid="row-prs-unread" className="text-muted-foreground">
        {opened > 0 ? t("openedNoLink", { count: opened }) : t("notRead")}
      </span>
    );
  }
  if (pulls.length === 0)
    return opened > 0 ? (
      <span data-testid="row-prs-nolink" title={t("noLinkHint")}>
        {t("openedNoLink", { count: opened })}
      </span>
    ) : (
      <span data-testid="row-prs-none" className="text-muted-foreground">
        {t("none")}
      </span>
    );
  const shown = pulls.slice(0, PRS_SHOWN);
  return (
    <ul data-testid="row-prs" className="flex min-w-36 flex-col gap-1">
      {shown.map((pull) => (
        <PullRequestItem key={pull.url} pull={pull} />
      ))}
      {pulls.length > shown.length ? (
        <li className="text-[11px] text-muted-foreground">
          {t("more", { count: pulls.length - shown.length })}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Lines added and removed, green and red, with what the figure is on hover
 * and in words for a screen reader. Git's figure counts only what was not yet
 * committed, and the cell says "uncommitted" under it.
 */
export function DiffCell({ diff }: { diff: RunDiff | null | undefined }) {
  const t = useTranslations("fleet.runs.diff");
  const locale = useLocale();
  if (diff === null || diff === undefined)
    return <span className="text-muted-foreground">{t("none")}</span>;
  return (
    <span
      data-testid="row-diff"
      data-basis={diff.basis}
      title={t(`basis.${diff.basis}`)}
      className="whitespace-nowrap font-mono tabular-nums"
    >
      <span aria-hidden="true">
        <span className="text-success">+{formatCount(diff.added, locale)}</span>{" "}
        <span className="text-error-ink">
          −{formatCount(diff.removed, locale)}
        </span>
      </span>
      <span className="sr-only">
        {t("spoken", {
          added: formatCount(diff.added, locale),
          removed: formatCount(diff.removed, locale),
        })}
      </span>
      {diff.basis === "git_observed" ? (
        <span className="block text-[10px] text-muted-foreground">
          {t("uncommitted")}
        </span>
      ) : null}
    </span>
  );
}
