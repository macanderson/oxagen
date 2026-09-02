"use client";

/**
 * overview-tab.tsx — repo.metrics summary + zero-state CTA.
 */

import * as React from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Stat, StatGroup } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { timeAgo } from "@/components/activity/format";
import type { RepoMetrics } from "@/lib/workbench/repos";
import { getRepoMetricsAction } from "../actions";

export interface OverviewTabProps {
  scope: { orgSlug: string; workspaceSlug: string };
  connectionId: string;
  initialMetrics: RepoMetrics | null;
  slug: { owner: string; repo: string } | null;
  onNavigateToBranches: () => void;
}

export function OverviewTab({
  scope,
  connectionId,
  initialMetrics,
  slug,
  onNavigateToBranches,
}: OverviewTabProps) {
  const [metrics, setMetrics] = React.useState(initialMetrics);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const retry = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getRepoMetricsAction({ ...scope, repoId: connectionId });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMetrics(res.metrics);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.orgSlug, scope.workspaceSlug, connectionId]);

  if (!metrics && !loading) {
    return (
      <ErrorState
        title="Couldn't load repo metrics"
        description={
          error ??
          "We couldn't read sync metrics for this repo connection. Try again."
        }
        retry={() => void retry()}
      />
    );
  }

  if (!metrics) {
    return (
      <div
        className="h-32 animate-pulse rounded-xl bg-muted"
        aria-hidden="true"
      />
    );
  }

  if (!slug) {
    return (
      <EmptyState
        icon={<GitBranch />}
        title="Repo setup incomplete"
        description="This connection hasn't resolved an owner/repo yet. Finish setup in Knowledge → Sources before branches, PRs, files, or locks can work."
        variant="dashed"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="repo-overview-tab">
      <StatGroup columns={4}>
        <Stat
          label="Entities ingested"
          value={metrics.entityCount.toLocaleString()}
        />
        <Stat
          label="Status"
          value={metrics.status}
          tone={
            metrics.status === "failed"
              ? "error"
              : metrics.status === "paused"
                ? "warning"
                : "neutral"
          }
        />
        <Stat
          label="Last sync"
          value={metrics.lastSyncAt ? timeAgo(metrics.lastSyncAt) : "Never"}
        />
        <Stat
          label="Next sync"
          value={
            metrics.estimatedNextSyncAt
              ? timeAgo(metrics.estimatedNextSyncAt)
              : "—"
          }
          hint={
            metrics.syncIntervalSeconds
              ? `every ${metrics.syncIntervalSeconds}s`
              : undefined
          }
        />
      </StatGroup>

      {metrics.errorMessage && (
        <p
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-testid="repo-overview-error"
        >
          {metrics.errorMessage}
        </p>
      )}

      {metrics.entityCount === 0 && (
        <EmptyState
          icon={<GitBranch />}
          title="No activity here yet"
          description={`Create your first branch on ${slug.owner}/${slug.repo} to get started.`}
          variant="muted"
          action={
            <Button
              size="sm"
              onClick={onNavigateToBranches}
              data-testid="overview-create-branch-cta"
            >
              Create your first branch
            </Button>
          }
        />
      )}
    </div>
  );
}
