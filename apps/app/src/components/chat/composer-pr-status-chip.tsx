"use client";

import * as React from "react";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  CiStatusSummary,
  type CiOverall,
  type CiStatusSummaryProps,
} from "./registry-components/ci-status-summary";

/**
 * composer-pr-status-chip — the compact "PR #123 ●" affordance shown in the
 * composer footer once the coding agent has opened a pull request for this
 * conversation.
 *
 * It renders the PR number (linking to GitHub) plus a small status circle whose
 * colour reflects the aggregated CI verdict for the PR head. Hovering the circle
 * opens a popover — a la Claude Code — that lists each check with how long it has
 * been running and the passed/ran tally (reusing the shared `CiStatusSummary`).
 *
 * CI is fetched lazily from `get_ci_status` (via the scoped API path) and polled
 * while the verdict is still pending so a running build ticks toward its result
 * without a page refresh. The component is entirely self-contained: give it the
 * repo coordinates + PR head ref and it does the rest.
 */

/** The PR coordinates the chip needs to render + fetch CI for. */
export interface ComposerPrStatus {
  /** Repository owner (user/org login). */
  owner: string;
  /** Repository name. */
  name: string;
  /** Pull-request number, e.g. 123. */
  number: number;
  /** HTML URL of the PR on GitHub (chip title links here). */
  url: string;
  /**
   * The ref `get_ci_status` reads CI for — the PR head branch when known, else
   * the PR's head SHA. Null disables the CI fetch (the chip still links out).
   */
  headRef: string | null;
}

/**
 * The minimal shape of a tool call the PR derivation reads — a structural
 * subset of the chat reducer's tool-call entries, so `deriveComposerPr` can be
 * unit-tested without the whole reducer state.
 */
export interface PrDerivationToolCall {
  capability: string;
  status: string;
  inputPreview: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Derive the composer's open-PR chip data from the conversation's tool calls.
 * Scans (in reducer order) for the LAST completed `edit_repo_file` (carries
 * `prNumber`/`prUrl`/`branch`) or `open_pr` (carries `number`/`htmlUrl`; head
 * ref from its input) and returns it, or null when no PR has been opened. Both
 * capabilities carry `owner`/`repo` in their input, so this is self-contained —
 * no external repo hint needed. `edit_repo_file` also yields the head branch,
 * which the CI fetch needs.
 *
 * @param orderedToolCalls tool calls in the order they appeared in the thread.
 */
export function deriveComposerPr(
  orderedToolCalls: PrDerivationToolCall[],
): ComposerPrStatus | null {
  let found: ComposerPrStatus | null = null;
  for (const tc of orderedToolCalls) {
    if (tc.status !== "completed" || !tc.output) continue;
    const owner = str(tc.inputPreview?.owner);
    const name = str(tc.inputPreview?.repo);
    if (owner === null || name === null) continue;
    if (tc.capability === "edit_repo_file") {
      const number = num(tc.output.prNumber);
      const url = str(tc.output.prUrl);
      if (number !== null && url !== null) {
        found = { owner, name, number, url, headRef: str(tc.output.branch) };
      }
    } else if (tc.capability === "open_pr") {
      const number = num(tc.output.number);
      const url = str(tc.output.htmlUrl);
      if (number !== null && url !== null) {
        // `open_pr` doesn't return the head ref — read it from the input.
        found = {
          owner,
          name,
          number,
          url,
          headRef: str(tc.inputPreview?.head),
        };
      }
    }
  }
  return found;
}

interface ComposerPrStatusChipProps {
  pr: ComposerPrStatus;
  /** Org slug for the scoped `get_ci_status` fetch. */
  orgSlug: string;
  /** Workspace slug for the scoped `get_ci_status` fetch. */
  workspaceSlug: string;
  /**
   * Poll interval while CI is still pending, in ms. Defaults to 15s. Exposed so
   * tests can drive it fast.
   */
  pollMs?: number;
}

/** The `{ overall, counts, runs }` shape `get_ci_status` returns (ref/sha ignored). */
type CiFetchResult = CiStatusSummaryProps;

/** Circle colour + a11y label for each aggregated verdict. */
const OVERALL_DOT: Record<
  CiOverall,
  {
    className: string;
    label: string;
    spin: boolean;
    Glyph: typeof CheckCircle2;
  }
> = {
  passing: {
    className: "text-success",
    label: "CI passing",
    spin: false,
    Glyph: CheckCircle2,
  },
  failing: {
    className: "text-error",
    label: "CI failing",
    spin: false,
    Glyph: XCircle,
  },
  pending: {
    className: "text-warning",
    label: "CI running",
    spin: true,
    Glyph: Loader2,
  },
  neutral: {
    className: "text-muted-foreground",
    label: "CI neutral",
    spin: false,
    Glyph: MinusCircle,
  },
  unknown: {
    className: "text-muted-foreground",
    label: "CI status unknown",
    spin: false,
    Glyph: MinusCircle,
  },
};

function isPending(ci: CiFetchResult | null): boolean {
  return ci?.overall === "pending";
}

export function ComposerPrStatusChip({
  pr,
  orgSlug,
  workspaceSlug,
  pollMs = 15_000,
}: ComposerPrStatusChipProps) {
  const [ci, setCi] = React.useState<CiFetchResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canFetch =
    Boolean(pr.headRef) && orgSlug !== "" && workspaceSlug !== "";

  // Fetch CI for the PR head, then keep polling while the verdict is pending so
  // a running build advances toward passing/failing without a manual refresh.
  //
  // KNOWN GAP: the catch below records the error but schedules NO successor
  // tick, and the effect deps don't change afterwards — so one failed request
  // (a network blip, a 502) freezes the chip at "Couldn't load CI status" for
  // the life of the mount. A fix needs a bounded retry on the same backoff.
  // Note also that this chip mounts up to three times per conversation (the
  // desktop rail's Context card, the mobile Activity sheet, and the composer),
  // each polling this URL independently.
  React.useEffect(() => {
    if (!canFetch || !pr.headRef) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const url =
      `/api/v1/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}` +
      `/repos/ci/status?owner=${encodeURIComponent(pr.owner)}` +
      `&repo=${encodeURIComponent(pr.name)}&ref=${encodeURIComponent(pr.headRef)}`;

    async function load(): Promise<void> {
      if (cancelled) return;
      setLoading((prev) => (ci === null ? true : prev));
      try {
        const res = await fetch(url, {
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as CiFetchResult;
        if (cancelled) return;
        setCi(json);
        setError(null);
        if (isPending(json)) {
          timer = setTimeout(() => void load(), pollMs);
        }
      } catch {
        if (cancelled) return;
        setError("Couldn't load CI status");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ci is intentionally read-only inside; re-fetch only when the PR/scope changes
  }, [canFetch, pr.owner, pr.name, pr.headRef, orgSlug, workspaceSlug, pollMs]);

  const overall: CiOverall = ci?.overall ?? "unknown";
  const dot = OVERALL_DOT[overall];
  const DotGlyph = dot.Glyph;

  return (
    <div
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      data-testid="composer-pr-status-chip"
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 font-medium tabular-nums text-foreground",
          "transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-label={`Pull request #${pr.number} on GitHub`}
        data-testid="composer-pr-link"
      >
        <GitPullRequest className="size-3.5 shrink-0" aria-hidden="true" />
        PR #{pr.number}
        <ExternalLink
          className="size-2.5 shrink-0 opacity-60"
          aria-hidden="true"
        />
      </a>

      <Popover>
        <PopoverTrigger
          openOnHover
          delay={120}
          render={
            <button
              type="button"
              className={cn(
                "inline-flex size-5 items-center justify-center rounded-full",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label={dot.label}
              data-testid="composer-ci-dot"
              data-overall={overall}
            />
          }
        >
          {loading && ci === null ? (
            <Loader2
              className="size-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <DotGlyph
              className={cn(
                "size-3.5",
                dot.className,
                dot.spin && "animate-spin",
              )}
              aria-hidden="true"
            />
          )}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          className="w-72 max-w-[calc(100vw-2rem)]"
          data-testid="composer-ci-popover"
        >
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <GitPullRequest className="size-3.5" aria-hidden="true" />
            <span className="truncate">
              {pr.owner}/{pr.name} #{pr.number}
            </span>
          </div>
          {error ? (
            <p className="text-xs text-muted-foreground">{error}</p>
          ) : !pr.headRef ? (
            <p className="text-xs text-muted-foreground">
              No head ref available — open the PR on GitHub for CI details.
            </p>
          ) : ci === null ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Loading CI status…
            </p>
          ) : ci.runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No checks reported yet.
            </p>
          ) : (
            <CiStatusSummary
              overall={ci.overall}
              counts={ci.counts}
              runs={ci.runs}
            />
          )}
        </PopoverPopup>
      </Popover>
    </div>
  );
}
