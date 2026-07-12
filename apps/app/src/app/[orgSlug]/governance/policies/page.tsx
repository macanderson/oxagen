import { Lock } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Policies (web-app-2.0 Phase 0 shell). IAM roles, entitlements, and MCP auth
 * alerts land in the Governance phase (ships read-only first; needs new IAM
 * roles/entitlements read+write contracts).
 */
export default function PoliciesPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Lock}
        title="Policies"
        description="IAM roles, entitlements, and MCP auth alerts are coming as part of Web App 2.0 (read-only first)."
      />
    </div>
  );
}
