import { SchemaBuilder } from "@/components/knowledge/schema-builder/schema-builder";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export const metadata = { title: "Knowledge Schema — Settings" };

export default async function KnowledgeSettingsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;

  // TODO: resolve actual member role from session to gate isAdmin correctly.
  // For now, pass isAdmin={true} as a stub — replace with a proper
  // role check (e.g. assertOrgMember / getSessionRole) before GA.
  return (
    <div className="px-6 pb-10">
      <SchemaBuilder
        slugs={{ orgSlug, workspaceSlug }}
        isAdmin={true}
      />
    </div>
  );
}
