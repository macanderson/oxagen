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
    { label: "Audit", href: org.security.audit(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Security"
        description="Append-only security event log for this organization."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
