import { PageHeader } from "@/components/ui/page-header";
import { SettingsNav } from "@/components/ui/settings-nav";
import { org } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function OrgSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx: ScopeContext = { orgSlug };

  const navItems = [
    { label: "General", href: org.settings.general(ctx) },
    { label: "Privacy", href: org.settings.privacy(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Organization Settings"
        description="Configure your organization, manage plugins, and govern third-party integrations."
      />
      <div className="flex gap-8">
        <aside className="w-48 shrink-0">
          <SettingsNav items={navItems} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
