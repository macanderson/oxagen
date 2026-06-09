/**
 * Account → Privacy: GDPR Art.17 (erasure) + Art.20 (portability) self-service.
 *
 * User-scoped. No org RBAC gate — every authenticated user has these rights.
 */

import { PageHeader } from "@/components/ui/page-header";
import { UserPrivacyPanel } from "./privacy-panel";

export const metadata = {
  title: "Privacy — Oxagen",
};

export default function AccountPrivacyPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Privacy"
        description="Exercise your GDPR rights: export your personal data or request account deletion."
      />
      <UserPrivacyPanel />
    </div>
  );
}
