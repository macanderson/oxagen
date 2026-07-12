import { Radio } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Triggers board (web-app-2.0 Phase 0 shell). Workspace-wide manual/cron/event
 * agent triggers land in the Automations phase.
 */
export default function TriggersPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Radio}
        title="Triggers"
        description="The workspace-wide agent trigger board — manual, cron, and event triggers — is coming as part of Web App 2.0."
      />
    </div>
  );
}
