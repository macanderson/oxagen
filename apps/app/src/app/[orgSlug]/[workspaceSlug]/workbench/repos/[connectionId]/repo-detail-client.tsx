"use client";

/**
 * repo-detail-client.tsx — Repo detail tab shell.
 *
 * Client-side tab state (not URL sub-routes — the spec doesn't require deep
 * links to a specific tab, and Base UI's Tabs.Panel unmounts inactive panels
 * by default, which is exactly the "a slow CI fetch never blocks Files"
 * requirement: only the active tab's component is mounted, so only it fetches.
 */

import * as React from "react";
import {
  GitBranch,
  GitPullRequest,
  Lock,
  FileCode2,
  LayoutDashboard,
} from "lucide-react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import type { RepoConnection, RepoMetrics } from "@/lib/workbench/repos";
import { OverviewTab } from "./overview-tab";
import { BranchesTab } from "./branches-tab";
import { PullRequestsTab } from "./pull-requests-tab";
import { FilesTab } from "./files-tab";
import { LocksTab } from "./locks-tab";

export interface RepoDetailClientProps {
  orgSlug: string;
  workspaceSlug: string;
  connection: RepoConnection;
  slug: { owner: string; repo: string } | null;
  initialMetrics: RepoMetrics | null;
  canManage: boolean;
  /**
   * The list page's "Open PRs"/"CI status" columns link here with ?tab=pulls
   * since there's no repo.pr.list to back a real count — page.tsx resolves
   * the `?tab=` query param server-side (avoids a client useSearchParams
   * Suspense boundary) and passes the validated tab down.
   */
  initialTab: TabValue;
}

export type TabValue = "overview" | "branches" | "pulls" | "files" | "locks";

export function RepoDetailClient({
  orgSlug,
  workspaceSlug,
  connection,
  slug,
  initialMetrics,
  canManage,
  initialTab,
}: RepoDetailClientProps) {
  const [tab, setTab] = React.useState<TabValue>(initialTab);
  // Branches tab hands off the branch it just created so the PR tab's "head"
  // field starts pre-filled — a small connected-UX touch, not a fetched list.
  const [suggestedHead, setSuggestedHead] = React.useState<string | null>(null);

  const scope = { orgSlug, workspaceSlug };

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as TabValue)}
      data-testid="repo-detail-tabs"
      className="flex flex-col gap-4"
    >
      <TabsList variant="underline">
        <TabsTab
          value="overview"
          data-testid="repo-tab-overview"
          className="gap-1.5"
        >
          <LayoutDashboard className="size-3.5" aria-hidden="true" />
          Overview
        </TabsTab>
        <TabsTab
          value="branches"
          data-testid="repo-tab-branches"
          className="gap-1.5"
        >
          <GitBranch className="size-3.5" aria-hidden="true" />
          Branches
        </TabsTab>
        <TabsTab value="pulls" data-testid="repo-tab-pulls" className="gap-1.5">
          <GitPullRequest className="size-3.5" aria-hidden="true" />
          Pull Requests
        </TabsTab>
        <TabsTab value="files" data-testid="repo-tab-files" className="gap-1.5">
          <FileCode2 className="size-3.5" aria-hidden="true" />
          Files
        </TabsTab>
        <TabsTab value="locks" data-testid="repo-tab-locks" className="gap-1.5">
          <Lock className="size-3.5" aria-hidden="true" />
          Locks
        </TabsTab>
      </TabsList>

      <TabsPanel value="overview">
        <OverviewTab
          scope={scope}
          connectionId={connection.publicId}
          initialMetrics={initialMetrics}
          slug={slug}
          onNavigateToBranches={() => setTab("branches")}
        />
      </TabsPanel>
      <TabsPanel value="branches">
        <BranchesTab
          scope={scope}
          slug={slug}
          canManage={canManage}
          onBranchCreated={(branch) => setSuggestedHead(branch)}
        />
      </TabsPanel>
      <TabsPanel value="pulls">
        <PullRequestsTab
          scope={scope}
          slug={slug}
          canManage={canManage}
          defaultHead={suggestedHead}
        />
      </TabsPanel>
      <TabsPanel value="files">
        <FilesTab scope={scope} slug={slug} canManage={canManage} />
      </TabsPanel>
      <TabsPanel value="locks">
        <LocksTab scope={scope} slug={slug} canManage={canManage} />
      </TabsPanel>
    </Tabs>
  );
}
