import { PageHeader } from "@/components/ui/page-header";
import { MobileSettingsNav, SettingsNav } from "@/components/ui/settings-nav";
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
        description="Configure your organization's general details and privacy controls."
      />
      {/* Desktop: fixed sidebar. Mobile: full-width content + MobileSettingsNav,
          a thumb-reachable bottom-sheet switcher (same items — parity per ADR-026). */}
      <div className="flex flex-col md:flex-row md:gap-8">
        <aside className="hidden w-48 shrink-0 md:block">
          <SettingsNav items={navItems} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
        <MobileSettingsNav items={navItems} label="Organization settings" />
      </div>
    </div>
  );
}
