import { Zap } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Automation editor (web-app-2.0 Phase 0 shell). Trigger config + playbook +
 * audited run history land in the Automations phase.
 */
export default function AutomationDetailPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Zap}
        title="Automation editor"
        description="The automation editor — trigger configuration, playbook, and audited run history — is coming as part of Web App 2.0."
      />
    </div>
  );
}
