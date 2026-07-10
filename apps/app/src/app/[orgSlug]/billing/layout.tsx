import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
import { org } from "@/lib/routes";

export default async function BillingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = { orgSlug };

  const tabs = [
    { label: "Subscription", href: org.billing.subscription(ctx) },
    { label: "Usage", href: org.billing.usage(ctx) },
    { label: "Revenue", href: org.billing.revenue(ctx) },
    { label: "Invoices", href: org.billing.invoices(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Billing"
        description="Plans, subscription, usage, and credits."
      />
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Billing" />
    </div>
  );
}
