import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
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
    { label: "Overview", href: org.security.root(ctx) },
    { label: "MFA", href: org.security.mfa(ctx) },
    { label: "Audit", href: org.security.audit(ctx) },
    { label: "Compliance", href: org.security.compliance(ctx) },
    { label: "Trust", href: org.security.trust(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Security"
        description="MFA, audit, compliance, and trust."
      />
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Security" />
    </div>
  );
}
