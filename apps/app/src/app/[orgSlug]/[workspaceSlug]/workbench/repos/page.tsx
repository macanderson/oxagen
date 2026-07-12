import { GitBranch } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Repos (web-app-2.0 Phase 0 shell). Home for the headless repo.* family
 * (sync, create, fork, edit→PR); the real surface lands in the Workbench phase.
 */
export default function ReposPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={GitBranch}
        title="Repos"
        description="Connected repositories — sync, fork, create, and agent edit→PR — are coming to the Workbench as part of Web App 2.0."
      />
    </div>
  );
}
