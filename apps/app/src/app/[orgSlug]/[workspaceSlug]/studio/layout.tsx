import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function StudioLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Compose", href: workspace.studio.compose(ctx) },
    { label: "Library", href: workspace.studio.library(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Studio"
        description="Compose and manage generated content."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.ask(ctx) },
              { label: "Studio" },
            ]}
          />
        }
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
