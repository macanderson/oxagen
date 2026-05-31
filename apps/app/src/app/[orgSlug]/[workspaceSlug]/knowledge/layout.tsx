import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function KnowledgeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Sources", href: workspace.knowledge.sources(ctx) },
    { label: "Graph", href: workspace.knowledge.graph(ctx) },
    { label: "Memories", href: workspace.knowledge.memories(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Knowledge"
        description="Data connections, ontology, and agent memories."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.chat(ctx) },
              { label: "Knowledge" },
            ]}
          />
        }
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
