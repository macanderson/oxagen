import { Network } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Fleet (web-app-2.0 Phase 0 shell). Subagent fan-out / fleet observability
 * with per-child lineage + cost lands in the Activity phase.
 */
export default function FleetPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Network}
        title="Fleet"
        description="Subagent fan-out and fleet observability — per-child lineage and cost — are coming as part of Web App 2.0."
      />
    </div>
  );
}
