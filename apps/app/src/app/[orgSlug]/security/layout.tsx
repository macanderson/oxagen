import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";

export default async function SecurityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = { orgSlug };

  const tabs = [
    { label: "SSO", href: org.security.sso(ctx) },
    { label: "SCIM", href: org.security.scim(ctx) },
    { label: "MFA", href: org.security.mfa(ctx) },
    { label: "Audit", href: org.security.audit(ctx) },
    { label: "Compliance", href: org.security.compliance(ctx) },
    { label: "Incidents", href: org.security.incidents(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Security"
        description="SSO, SCIM, MFA, audit, compliance, and incidents."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
