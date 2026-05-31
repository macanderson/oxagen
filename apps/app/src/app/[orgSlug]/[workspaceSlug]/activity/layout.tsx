import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function ActivityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Runs", href: workspace.activity.runs(ctx) },
    { label: "Approvals", href: workspace.activity.approvals(ctx) },
    { label: "Audit", href: workspace.activity.audit(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Activity"
        description="Live and historical runs, approvals, and the workspace audit log."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.chat(ctx) },
              { label: "Activity" },
            ]}
          />
        }
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
