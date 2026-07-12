import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Capability & Contract catalog (web-app-2.0 Phase 0 shell). The flagship
 * surface — every typed contract rendered as the one enforced object — lands in
 * the Governance phase (needs capability.registry.list/get contracts).
 */
export default function CapabilitiesCatalogPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={ShieldCheck}
        title="Capability & Contract catalog"
        description="The org-wide typed-contract catalog — each capability shown as identity → scope → action → terms → outcome → audit — is coming as part of Web App 2.0."
      />
    </div>
  );
}
