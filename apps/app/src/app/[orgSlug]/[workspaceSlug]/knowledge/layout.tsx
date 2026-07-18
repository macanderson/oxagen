import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import { workspaceCrumb } from "@/lib/breadcrumbs";
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
  const wsCrumb = await workspaceCrumb(orgSlug, workspaceSlug);

  const tabs = [
    { label: "Sources", href: workspace.knowledge.sources(ctx) },
    { label: "Graph", href: workspace.knowledge.graph(ctx) },
    { label: "Inference", href: workspace.knowledge.inference(ctx) },
    { label: "Ontology", href: workspace.knowledge.ontology(ctx) },
    { label: "Memory", href: workspace.knowledge.memory(ctx) },
    { label: "Citations", href: workspace.knowledge.citations(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <div className="flex items-center justify-between gap-4">
        <PageHeader
          title="Knowledge"
          description="Sources, graph, inference, ontology, and agent memory."
          breadcrumb={<Breadcrumb items={[wsCrumb, { label: "Knowledge" }]} />}
        />
      </div>
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Knowledge" />
    </div>
  );
}
