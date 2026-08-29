"use client";

/**
 * pull-requests-tab.tsx — Open a PR (repo.pr.open), look up a PR by number
 * (repo.pr.get + repo.pr.diff, which embeds CI for the PR head), and check
 * CI for an arbitrary ref/branch (repo.ci.status).
 *
 * There is no repo.pr.list capability today, so this tab cannot show a true
 * PR list without fabricating data. "Look up PR #" is the substitute for a
 * list.
 */

import * as React from "react";
import { GitPullRequest } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import type { RepoPrGetOutput } from "@oxagen/oxagen/contracts/repo.pr.get";
import type { RepoPrDiffOutput } from "@oxagen/oxagen/contracts/repo.pr.diff";
import type { RepoCiStatusOutput } from "@oxagen/oxagen/contracts/repo.ci.status";
import {
  getPrAction,
  getPrDiffAction,
  openPrAction,
  getCiStatusAction,
} from "../actions";

export interface PullRequestsTabProps {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string } | null;
  canManage: boolean;
  defaultHead: string | null;
}

const CI_BADGE: Record<string, "success" | "warning" | "error" | "muted"> = {
  passing: "success",
  pending: "warning",
  failing: "error",
  neutral: "muted",
  unknown: "muted",
};

export function PullRequestsTab({
  scope,
  slug,
  canManage,
  defaultHead,
}: PullRequestsTabProps) {
  if (!slug) {
    return (
      <EmptyState
        icon={<GitPullRequest />}
        title="Repo setup incomplete"
        description="Finish connecting a repo before working with pull requests."
        variant="dashed"
      />
    );
  }
  return (
    <div className="flex flex-col gap-8" data-testid="repo-pulls-tab">
      <OpenPrForm
        scope={scope}
        slug={slug}
        canManage={canManage}
        defaultHead={defaultHead}
      />
      <LookupPr scope={scope} slug={slug} />
      <CheckCi scope={scope} slug={slug} />
    </div>
  );
}

// ── Open a PR ────────────────────────────────────────────────────────────────

function OpenPrForm({
  scope,
  slug,
  canManage,
  defaultHead,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string };
  canManage: boolean;
  defaultHead: string | null;
}) {
  const [title, setTitle] = React.useState("");
  const [head, setHead] = React.useState(defaultHead ?? "");
  const [base, setBase] = React.useState("main");
  const [body, setBody] = React.useState("");
  const [draft, setDraft] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    number: number;
    htmlUrl: string;
  } | null>(null);

  React.useEffect(() => {
    if (defaultHead) setHead(defaultHead);
  }, [defaultHead]);

  if (!canManage) return null;

  async function submit() {
    setSubmitting(true);
    setError(null);
    const res = await openPrAction({
      ...scope,
      owner: slug.owner,
      repo: slug.repo,
      title,
      head,
      base,
      body: body.trim() || undefined,
      draft,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">
        Open a pull request
      </h3>
      {result ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-border/60 p-3"
          data-testid="open-pr-success"
        >
          <p className="text-sm text-foreground">
            Opened <span className="font-medium">#{result.number}</span>.
          </p>
          <a
            href={result.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            View on GitHub ↗
          </a>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setResult(null)}
          >
            Open another
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pr-title">Title</Label>
            <Input
              id="pr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              data-testid="pr-title-input"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="pr-head">Head branch</Label>
              <Input
                id="pr-head"
                value={head}
                onChange={(e) => setHead(e.target.value)}
                required
                data-testid="pr-head-input"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="pr-base">Base branch</Label>
              <Input
                id="pr-base"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pr-body">Description (optional)</Label>
            <Textarea
              id="pr-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={draft}
              onCheckedChange={(c) => setDraft(c === true)}
            />
            Open as draft
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={
              submitting || !title.trim() || !head.trim() || !base.trim()
            }
            data-testid="open-pr-submit"
            className="self-start"
          >
            {submitting ? "Opening…" : "Open PR"}
          </Button>
        </form>
      )}
    </section>
  );
}

// ── Look up a PR ─────────────────────────────────────────────────────────────

function LookupPr({
  scope,
  slug,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string };
}) {
  const [number, setNumber] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pr, setPr] = React.useState<RepoPrGetOutput | null>(null);
  const [diff, setDiff] = React.useState<RepoPrDiffOutput | null>(null);

  async function lookup() {
    const num = Number(number);
    if (!Number.isInteger(num) || num <= 0) {
      setError("Enter a valid PR number.");
      return;
    }
    setLoading(true);
    setError(null);
    setPr(null);
    setDiff(null);
    const [prRes, diffRes] = await Promise.all([
      getPrAction({
        ...scope,
        owner: slug.owner,
        repo: slug.repo,
        number: num,
      }),
      getPrDiffAction({
        ...scope,
        owner: slug.owner,
        repo: slug.repo,
        number: num,
      }),
    ]);
    setLoading(false);
    if (!prRes.ok) {
      setError(prRes.error);
      return;
    }
    setPr(prRes.result);
    if (diffRes.ok) setDiff(diffRes.result);
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">
        Look up a pull request
      </h3>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pr-lookup-number">PR number</Label>
          <Input
            id="pr-lookup-number"
            type="number"
            min={1}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className="w-32"
            data-testid="pr-lookup-input"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={loading}
          data-testid="pr-lookup-submit"
        >
          {loading ? "Loading…" : "Look up"}
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {pr && (
        <div
          className="flex flex-col gap-3 rounded-md border border-border/60 p-3"
          data-testid="pr-lookup-result"
        >
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              #{pr.number} {pr.title}
            </a>
            <Badge
              variant={
                pr.state === "merged"
                  ? "success"
                  : pr.state === "closed"
                    ? "muted"
                    : "info"
              }
            >
              {pr.state}
            </Badge>
            {pr.draft && <Badge variant="muted">draft</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {pr.author ?? "unknown"} · {pr.headRef} → {pr.baseRef} · +
            {pr.additions} -{pr.deletions} · {pr.changedFiles} files
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={CI_BADGE[pr.ci.overall] ?? "muted"}
              data-testid="pr-ci-overall"
            >
              CI: {pr.ci.overall}
            </Badge>
            {pr.ci.runs.map((run) => (
              <Badge
                key={run.name}
                variant={
                  run.conclusion === "success"
                    ? "success"
                    : run.conclusion === "failure"
                      ? "error"
                      : "muted"
                }
              >
                {run.name}
              </Badge>
            ))}
          </div>
          {diff && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                {diff.summary}
              </p>
              {diff.files.map((f) => (
                <details
                  key={f.path}
                  className="rounded-md border border-border/40"
                >
                  <summary className="cursor-pointer px-2 py-1 font-mono text-xs text-foreground">
                    {f.path}{" "}
                    <span className="text-muted-foreground">({f.status})</span>
                  </summary>
                  {f.patch && (
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all px-2 py-1.5 text-[11px] text-muted-foreground">
                      {f.patch}
                    </pre>
                  )}
                </details>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Check CI for a ref ───────────────────────────────────────────────────────

function CheckCi({
  scope,
  slug,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string };
}) {
  const [ref, setRef] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<RepoCiStatusOutput | null>(null);

  async function check() {
    if (!ref.trim()) return;
    setLoading(true);
    setError(null);
    const res = await getCiStatusAction({
      ...scope,
      owner: slug.owner,
      repo: slug.repo,
      ref: ref.trim(),
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStatus(res.result);
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">
        Check CI for a branch or ref
      </h3>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ci-ref">Branch, SHA, or ref</Label>
          <Input
            id="ci-ref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="main"
            data-testid="ci-ref-input"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={loading || !ref.trim()}
          data-testid="ci-check-submit"
        >
          {loading ? "Checking…" : "Check CI"}
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {status && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          data-testid="ci-status-result"
        >
          <Badge variant={CI_BADGE[status.overall] ?? "muted"}>
            {status.overall} ({status.counts.passed}/{status.counts.total})
          </Badge>
          {status.runs.map((run) => (
            <Badge
              key={run.name}
              variant={
                run.conclusion === "success"
                  ? "success"
                  : run.conclusion === "failure"
                    ? "error"
                    : "muted"
              }
            >
              {run.name}
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}
