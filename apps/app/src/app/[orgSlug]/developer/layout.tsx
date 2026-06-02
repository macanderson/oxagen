import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";

export default async function DeveloperLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = { orgSlug };

  const tabs = [
    { label: "MCP", href: org.developer.mcp(ctx) },
    { label: "Tokens", href: org.developer.tokens(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Developer"
        description="MCP server configuration and API tokens."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
