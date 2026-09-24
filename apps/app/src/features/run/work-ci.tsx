// The run's work evidence (`get_run_work`, #3778): the checkouts the collector
// recorded, the pull requests the run pushed to or that match its commits,
// and their checks. The spec (pages/run.md) draws this record in three places
// rather than a section of its own: the header's checkout strip, the side
// column's Changes panel, and Linked work on the Issues tab. All three read
// the helpers below from the one read, so no two of them can name a different
// repository or pull request (audit check 12).
//
// The read reaches a forge, so the page starts it and never waits on it: each
// place that draws it sits inside its own Suspense boundary and reads the one
// promise with `use`, and a read that fails leaves each place drawing only
// what the run record carries.
import { useTranslations } from "next-intl";
import { type ReactNode, use } from "react";
import type { RunWork } from "@/data/contracts/run-work";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { parseGitHubUrl } from "@/shared/github-url";
import { GitHubLink } from "@/ui/navigation";

export type RunWorkPull = RunWork["pullRequests"][number];
type Repository = NonNullable<RunWork["checkouts"][number]["repository"]>;

/** Starts the read without waiting on it; a thrown read folds to the page's read error. */
export function readRunWork(
  ctx: WsCtx,
  source: DataSource,
  runId: string,
): Promise<Read<RunWork>> {
  return source.runs
    .work(ctx, runId)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
}

/**
 * Reads a started work read inside a Suspense boundary and hands the settled
 * value to `children`. Each place that draws the work evidence wraps itself in
 * one, with a fallback drawn from the run record alone.
 */
export function WithWork({
  read,
  children,
}: {
  read: Promise<Read<RunWork>>;
  children: (work: Read<RunWork>) => ReactNode;
}) {
  return children(use(read));
}

/** The settled value, or null when the read failed. */
export function workOf(read: Read<RunWork> | null): RunWork | null {
  return read?.ok === true ? read.value : null;
}

/** Seqs are decimal strings: the longer one is later, then the larger. */
function laterSeq(a: string, b: string): boolean {
  return a.length === b.length ? a > b : a.length > b.length;
}

/**
 * The checkout the session touched last: the directory the run worked in. A
 * session that moved between checkouts is placed by the one it ended in.
 */
export function checkoutOf(work: RunWork | null) {
  return (
    work?.checkouts.reduce<RunWork["checkouts"][number] | null>(
      (latest, checkout) =>
        latest === null || laterSeq(checkout.lastSeq, latest.lastSeq)
          ? checkout
          : latest,
      null,
    ) ?? null
  );
}

/**
 * Every repository the run touched, once each: the checkouts first, in the
 * order the collector recorded them, then any a pull request names.
 */
export function repositoriesOf(work: RunWork | null): Repository[] {
  if (work === null) return [];
  const seen = new Map<string, Repository>();
  for (const checkout of work.checkouts)
    if (checkout.repository !== null && !seen.has(checkout.repository.url))
      seen.set(checkout.repository.url, checkout.repository);
  for (const pull of work.pullRequests)
    if (!seen.has(pull.repository.url))
      seen.set(pull.repository.url, pull.repository);
  return [...seen.values()];
}

/** The pull request whose head is this branch, when the run pushed to one. */
export function pullForBranch(
  work: RunWork | null,
  branch: string | null,
): RunWorkPull | null {
  if (work === null || branch === null) return null;
  return work.pullRequests.find((pull) => pull.headRef === branch) ?? null;
}

/**
 * The page on the forge for a branch: the pull request it heads, else the
 * repository's tree at that branch. Never `/tree/refs/pull/…`: a pull request
 * head links to the pull request.
 */
export function branchUrl(
  repository: Repository | null,
  branch: string,
  pull: RunWorkPull | null,
): string | null {
  if (pull !== null) return pull.url;
  if (repository === null || branch.startsWith("refs/pull/")) return null;
  const path = branch.split("/").map(encodeURIComponent).join("/");
  return `${repository.url}/tree/${path}`;
}

/** The checks state the Changes panel badge carries: the first pull request that reported checks. */
export function checksOf(work: RunWork | null) {
  return work?.pullRequests.find((pull) => pull.ci !== null)?.ci ?? null;
}

/**
 * A link to a page on the forge. A URL that is not a GitHub page (another
 * host, a malformed value) is drawn as text rather than as a link Oxagen
 * cannot vouch for.
 */
export function ForgeLink({
  url,
  className,
  children,
}: {
  url: string | null;
  className?: string;
  children: ReactNode;
}) {
  const target = parseGitHubUrl(url);
  return target === null ? (
    <span className={className}>{children}</span>
  ) : (
    <GitHubLink to={target} className={className}>
      {children}
    </GitHubLink>
  );
}

/** `owner/name#N`, the way a pull request is named across the page. */
export function pullName(pull: RunWorkPull): string {
  return `${pull.repository.owner}/${pull.repository.name}#${String(pull.number)}`;
}

/** A pull request's state word, as the Changes panel and the strip both print it. */
export function usePullState() {
  const t = useTranslations("run.workCi.pullState");
  return (pull: RunWorkPull) => t(pull.state);
}
