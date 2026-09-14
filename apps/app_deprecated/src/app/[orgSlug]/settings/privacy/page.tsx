import { PageHeader } from "@/components/ui/page-header";
import { OrgPrivacyPanel } from "./org-privacy-panel";

export const metadata = {
  title: "Privacy — Organization Settings",
};

export default async function OrgPrivacyPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Privacy"
        description="Export or delete organization data. GDPR Article 17 (erasure) and Article 20 (portability)."
      />
      <OrgPrivacyPanel orgSlug={orgSlug} />
    </div>
  );
}
