import { Zap } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Automations (web-app-2.0 Phase 0 shell).
 *
 * Route registered + linked in nav now so the IA resolves with no 404s; the
 * real list (human-gated enable, audited run history over the automation.* /
 * workflow.* families) lands in the Automations phase.
 */
export default function AutomationsPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Zap}
        title="Automations"
        description="Human-gated agent automations — triggers, playbooks, and audited run history — are coming to this workspace as part of Web App 2.0."
      />
    </div>
  );
}
