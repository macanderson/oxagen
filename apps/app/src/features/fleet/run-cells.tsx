"use client";
// The Fleet runs table's cells that board.tsx draws from one row each: the
// summary, the pull requests, the lines changed, the tokens and the status
// word, and the Tokens shown tile. Kept out of board.tsx to keep that file
// under 1,500 lines.
import { GitPullRequest } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  type RunDiff,
  type RunPullRequest,
  type RunRow,
  staleReason,
} from "@/data/contracts/runs";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  linkText,
  mono,
  statNote,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount, formatRatio } from "@/ui/money-format";
import { PullRequestLink } from "@/ui/navigation";
import { StatusBadge } from "@/ui/status-badge";
import { shownTokens, tokensShown } from "./tokens";
import {
  forgeOf,
  type ListedRun,
  pullRequestLabel,
  type RowState,
} from "./view";

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
 * state. The state is the one a forge last reported (ADR-192), with when
 * Oxagen read it on hover. With none reported it reads "status unknown" and
 * says on hover where the live state is.
 */
function PullRequestItem({ pull }: { pull: RunPullRequest }) {
  const t = useTranslations("fleet.runs.prs");
  const format = useFormatter();
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
          {...(pull.stateSeenAt === null || pull.stateSeenAt === undefined
            ? {}
            : {
                title: t("stateSeen", {
                  when: format.dateTime(new Date(pull.stateSeenAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                }),
              })}
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

/**
 * A row's tokens: the total, with the share of its input served from cache
 * beneath. The agent's own count stands in while no rollup row exists, and
 * says so. A run with neither reads "not recorded", never a zero.
 */
export function TokensCell({ run }: { run: RunRow }) {
  const t = useTranslations("fleet.runs");
  const locale = useLocale();
  const shown = shownTokens(run);
  if (shown === null)
    return (
      <span
        data-testid="row-tokens"
        data-recorded="false"
        className="text-muted-foreground"
      >
        {t("notRecorded")}
      </span>
    );
  return (
    <span
      data-testid="row-tokens"
      data-recorded="true"
      data-basis={shown.reported ? "reported" : "rollup"}
      {...(shown.reported ? { title: t("tokens.reportedHint") } : {})}
      className="whitespace-nowrap font-mono tabular-nums"
    >
      {formatCount(shown.total, locale)}
      {shown.cached === null ? null : (
        <span className="block text-[10px] text-muted-foreground">
          {t("tokens.cached", { ratio: formatRatio(shown.cached, locale) })}
        </span>
      )}
      {shown.reported ? (
        <span className="block text-[10px] text-muted-foreground">
          {t("tokens.reported")}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The Tokens shown tile: the sum of the Tokens column over the rows listed,
 * with the share served from cache weighted by each row's spend. It draws
 * the same term, value and note as the strip's other tiles.
 */
export function TokensTile({ listed }: { listed: readonly ListedRun[] }) {
  const t = useTranslations("fleet.stats.tokens");
  const locale = useLocale();
  const shown = tokensShown(listed);
  const note = [
    shown.servedFromCache === null
      ? t("noCache")
      : t("servedFromCache", {
          ratio: formatRatio(shown.servedFromCache, locale),
        }),
    ...(shown.reported > 0 ? [t("reported", { count: shown.reported })] : []),
    ...(shown.total !== null && shown.unrecorded > 0
      ? [t("unrecorded", { count: shown.unrecorded })]
      : []),
  ].join(" · ");
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>{t("title")}</dt>
      <dd className={`${statValue} tabular-nums`}>
        {shown.total === null ? (
          <span
            data-testid="tokens-not-recorded"
            data-recorded="false"
            className="text-base font-medium text-muted-foreground"
          >
            {t("notRecorded")}
          </span>
        ) : (
          <span data-testid="tokens-shown" data-recorded="true">
            {formatCount(shown.total, locale)}
          </span>
        )}
      </dd>
      <dd className={statNote}>
        <span data-testid="tokens-cache">{note}</span>
      </dd>
    </dl>
  );
}

/**
 * The status words a row can read as: every `RowState`, and paused and
 * compacted, the two facts beside a run's status (ADR-193).
 * @internal Exported for its component test.
 */
export type RowWord = RowState | "paused" | "compacted";

/**
 * A row's status word. Parked, paused and compacted are facts beside the
 * run's lifecycle status (ADR-193), so each draws its own word here, and
 * paused and compacted say on hover what the word means. Every other state
 * is the lifecycle word `StatusBadge` draws.
 *
 * A stale run's host went quiet, so its parked call or its pause is no longer
 * news of the run: stale wins over both, as on the Run page's header. A
 * compacted run is sealed, and a sealed run never reads stale.
 */
export function RowStatusBadge({
  run,
  state,
}: {
  run: RunRow;
  state: RowWord;
}) {
  const t = useTranslations("fleet.runs");
  const stale = staleReason(run);
  if (stale !== null)
    return (
      <StatusBadge
        status={run.status}
        outcome={run.outcome}
        vocabulary="lifecycle"
        stale={stale}
      />
    );
  switch (state) {
    case "parked":
      return (
        <Badge tone="approval" data-status="parked">
          {t("parked")}
        </Badge>
      );
    case "paused":
      return (
        <Badge tone="approval" dot data-status="paused" title={t("pausedHint")}>
          {t("paused")}
        </Badge>
      );
    case "compacted":
      return (
        <Badge
          tone="quiet"
          dot
          data-status="compacted"
          title={t("compactedHint")}
        >
          {t("compacted")}
        </Badge>
      );
    default:
      return (
        <StatusBadge
          status={run.status}
          outcome={run.outcome}
          vocabulary="lifecycle"
        />
      );
  }
}
