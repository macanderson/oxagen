import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function WorkflowsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Workflows"
        description="Parallel research and data-gathering workflows for this workspace."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.ask(ctx) },
              { label: "Workflows" },
            ]}
          />
        }
      />
      {children}
    </div>
  );
}
