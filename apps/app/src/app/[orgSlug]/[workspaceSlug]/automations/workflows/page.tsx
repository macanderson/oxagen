import { Workflow } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Workflows (web-app-2.0 Phase 0 shell). Parallel workflow/swarm runs with
 * typed lineage + cost land in the Automations phase.
 */
export default function WorkflowsPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Workflow}
        title="Workflows"
        description="Parallel workflow and swarm runs — with typed lineage and per-run cost — are coming as part of Web App 2.0."
      />
    </div>
  );
}
