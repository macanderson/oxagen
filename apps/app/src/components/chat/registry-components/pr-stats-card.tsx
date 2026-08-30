"use client";

import type { ReactElement } from "react";
import {
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import {
  CiStatusSummary,
  type CiCounts,
  type CiOverall,
  type CiRun,
} from "./ci-status-summary";

/**
 * pr-stats-card — PR summary + stats + comments + CI, fed by `repo.pr.get`.
 *
 * componentId: "pr-stats"
 *
 * Props are the FULL `repo.pr.get` output (flat, component-specific). The CI
 * portion is rendered by the shared `<CiStatusSummary />` — the same component
 * the standalone ci-status card uses — so the two cards read identically. The
 * `ci` field is the CiStatus subset WITHOUT ref/sha.
 */

/** PR-embedded CI — CiStatus minus ref/sha. */
export interface PrCi {
  overall: CiOverall;
  counts: CiCounts;
  runs: CiRun[];
}

export interface PrComment {
  id: string;
  author: string | null;
  authorAvatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string | null;
  kind: "issue" | "review";
  /** Set for review comments (file path), else null. */
  path: string | null;
}

export interface PrStatsCardProps {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  authorAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  /** Total issue comments (true count from GitHub). */
  commentCount: number;
  /** Total inline review comments (true count). */
  reviewCommentCount: number;
  /** Capped list actually fetched (<= 50), newest first. */
  comments: PrComment[];
  ci: PrCi;
}

/**
 * Relative-time helper — "just now" / "5m ago" / "2h ago" / "3d ago", falling
 * back to a locale date past a week. Self-contained, no date library.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Author chip — a small round avatar image when a URL is present, else a
 * hand-rolled initial tile (no Avatar primitive exists in this UI system).
 */
function AuthorAvatar({
  author,
  authorAvatarUrl,
  size = "sm",
}: {
  author: string | null;
  authorAvatarUrl: string | null;
  size?: "sm" | "xs";
}): ReactElement {
  const dimension = size === "sm" ? "size-5" : "size-4";
  const label = author ?? "unknown";
  if (authorAvatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote GitHub avatar, no next/image loader configured for arbitrary hosts
      <img
        src={authorAvatarUrl}
        alt=""
        className={cn(dimension, "shrink-0 rounded-full object-cover")}
      />
    );
  }
  const initial = (author ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        dimension,
        "flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground",
      )}
    >
      {initial}
    </span>
  );
}

function StateBadge({
  state,
  draft,
}: {
  state: PrStatsCardProps["state"];
  draft: boolean;
}): ReactElement {
  if (state === "merged") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
        <GitMerge className="size-3" aria-hidden="true" />
        Merged
      </span>
    );
  }
  if (state === "closed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
        Closed
      </span>
    );
  }
  // open
  if (draft) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        Draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
      Open
    </span>
  );
}

function CommentEntry({ comment }: { comment: PrComment }): ReactElement {
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 pb-2 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <AuthorAvatar
          author={comment.author}
          authorAvatarUrl={comment.authorAvatarUrl}
          size="xs"
        />
        <span className="font-medium text-foreground">
          {comment.author ?? "unknown"}
        </span>
        <span className="text-muted-foreground">
          {relativeTime(comment.createdAt)}
        </span>
        {comment.kind === "review" ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-info">
            review
            {comment.path ? (
              <span className="font-mono text-[10px]">{comment.path}</span>
            ) : null}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            issue
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words text-xs text-foreground">
        {comment.body}
      </p>
    </li>
  );
}

export default function PrStatsCard(props: PrStatsCardProps): ReactElement {
  const {
    number,
    title,
    url,
    state,
    draft,
    author,
    authorAvatarUrl,
    createdAt,
    baseRef,
    headRef,
    additions,
    deletions,
    changedFiles,
    commits,
    commentCount,
    reviewCommentCount,
    comments,
    ci,
  } = props;

  const totalComments = commentCount + reviewCommentCount;
  const hasComments = totalComments > 0;
  const truncated = totalComments > comments.length;
  // `url` arrives with the capability output, so the scheme is allow-listed
  // before it becomes an href. An unsafe value degrades to plain text rather
  // than arming a `javascript:` navigation on click.
  const prHref = safeHref(url);

  return (
    <div
      className="my-2 rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="pr-stats-card"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <GitPullRequest
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <StateBadge state={state} draft={draft} />
        {prHref ? (
          <a
            href={prHref}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-w-0 flex-1 items-center gap-1 text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="shrink-0 text-muted-foreground">#{number}</span>
            <span className="min-w-0 truncate" title={title}>
              {title}
            </span>
            <ExternalLink
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </a>
        ) : (
          <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-sm font-medium text-foreground">
            <span className="shrink-0 text-muted-foreground">#{number}</span>
            <span className="min-w-0 truncate" title={title}>
              {title}
            </span>
          </span>
        )}
      </div>

      {/* Meta row: author + created time */}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        <AuthorAvatar author={author} authorAvatarUrl={authorAvatarUrl} />
        <span className="font-medium text-foreground">
          {author ?? "unknown"}
        </span>
        <span>opened {relativeTime(createdAt)}</span>
      </div>

      {/* Stat row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <GitBranch className="size-3.5" aria-hidden="true" />
          <span className="font-mono text-foreground">{baseRef}</span>
          <span aria-hidden="true">←</span>
          <span className="font-mono text-foreground">{headRef}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="text-success">+{additions}</span>
          <span className="text-error">−{deletions}</span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          {changedFiles} file{changedFiles === 1 ? "" : "s"}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {commits} commit{commits === 1 ? "" : "s"}
        </span>
      </div>

      {/* Comments */}
      <div className="border-t border-border/60 px-4 py-2.5">
        {hasComments ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {totalComments} comment{totalComments === 1 ? "" : "s"}
              </span>
            </summary>
            <ul className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-2">
              {comments.map((comment) => (
                <CommentEntry key={comment.id} comment={comment} />
              ))}
            </ul>
            {truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing latest {comments.length} of {totalComments}
                {prHref ? (
                  <>
                    {" — "}
                    <a
                      href={prHref}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      view all on GitHub
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </details>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
            No comments
          </span>
        )}
      </div>

      {/* CI checks */}
      <div className="border-t border-border/60 px-4 py-2.5">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Checks</p>
        {ci.runs.length > 0 ? (
          <CiStatusSummary
            overall={ci.overall}
            counts={ci.counts}
            runs={ci.runs}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            No CI checks reported for this PR.
          </p>
        )}
      </div>
    </div>
  );
}
