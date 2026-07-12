import { Scale } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Governance hub (web-app-2.0 Phase 0 shell). Renders the six links of the
 * accountability chain (identity → scope → action → terms → outcome → audit)
 * as a board; the real hub lands in the Governance phase.
 */
export default function GovernancePage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Scale}
        title="Governance"
        description="The accountability-chain hub — identity → knowledge scope → permitted action → commercial terms → verified outcome → audit record — is coming as part of Web App 2.0."
      />
    </div>
  );
}
