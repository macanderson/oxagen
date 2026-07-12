import { GitBranch } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Repo detail (web-app-2.0 Phase 0 shell). Branches, PRs, diffs, CI, file
 * commits, and file locks land in the Workbench phase.
 */
export default function RepoDetailPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={GitBranch}
        title="Repo detail"
        description="Branches, pull requests, diffs, CI, file commits, and file locks are coming as part of Web App 2.0."
      />
    </div>
  );
}
