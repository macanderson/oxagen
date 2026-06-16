import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function AgentsLayout({
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
        title="Agents"
        description="Define, version, deploy, and trigger workspace agents."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.ask(ctx) },
              { label: "Agents", href: workspace.agents.root(ctx) },
            ]}
          />
        }
      />
      <div className="mt-6">{children}</div>
    </div>
  );
}
