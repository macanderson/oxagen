import { eq, and } from "drizzle-orm";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { planLabelFrom } from "@/lib/plan-label";
import { isLowBalance } from "@oxagen/billing";
import { AppShell } from "@/components/shell/app-shell";
import { PageContextProvider } from "@/lib/page-context";
import { AskDrawer } from "@/components/shell/ask/ask-drawer";
import { CommandMenu } from "@/components/shell/ask/command-menu";
import { FillOverlay } from "@/components/shell/ask/fill-overlay";
import { resolvedTierCatalog } from "@oxagen/ai";
import { WandButton, WandPanel } from "@/components/shell/wand";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug } = await params;
  const org = await resolveOrg(orgSlug);
  // Tenant isolation: gate EVERY org-scoped page on membership. Without this
  // an authenticated user could read any org's data by guessing the slug
  // (IDOR). Non-members get a 404 via notFound() — indistinguishable from an
  // unknown org. This is the single enforcement point for all [orgSlug] routes.
  await assertOrgMember(org.id, session.user.id);

  const [orgRows, workspacesRows, lowBalance] = await Promise.all([
    // Cross-tenant read: the user's full org list (pre-scope, identity resolution).
    // withSystemDb bypasses RLS deliberately — OXA-1515.
    withSystemDb((tx) =>
      tx
        .select({
          publicId: schema.organizations.publicId,
          slug: schema.organizations.slug,
          name: schema.organizations.name,
          avatarUrl: schema.organizations.avatarUrl,
          planType: schema.organizations.planType,
          subscriptionTier: schema.plans.tier,
        })
        .from(schema.orgUsers)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgUsers.orgId))
        .leftJoin(
          schema.subscriptions,
          and(
            eq(schema.subscriptions.orgId, schema.organizations.id),
            eq(schema.subscriptions.status, "active"),
          ),
        )
        .leftJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
        .where(eq(schema.orgUsers.userId, session.user.id)),
    ),
    // Org-scoped workspace list — sentinel workspace id (org_only table). — OXA-1515
    runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      () =>
        withTenantDb((tx) =>
          tx
            .select({
              publicId: schema.workspaces.publicId,
              slug: schema.workspaces.slug,
              name: schema.workspaces.name,
            })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, org.id))
            .limit(100), // cap for picker UX; search/scroll needed beyond this
        ),
    ),
    // Always-visible credit balance for the shell header. credit_lots is org_only
    // under RLS → tenant scope. Degrade to null (pill hidden) on any failure so a
    // billing read never blocks the whole app shell from rendering. — OXA-1515
    runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
      isLowBalance(org.id),
    ).catch(() => null),
  ]);

  // Shape the org rows for the picker: a flat { …identity, avatarUrl, planLabel }.
  const availableOrgs = orgRows.map((o) => ({
    publicId: o.publicId,
    slug: o.slug,
    name: o.name,
    avatarUrl: o.avatarUrl,
    planLabel: planLabelFrom(o.subscriptionTier, o.planType),
  }));

  const user = {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email,
    image: session.user.image ?? null,
  };

  // The ctx passed to the shell's Ask system has no workspaceSlug at this
  // layout level. The sidebar is a client component that reads usePathname()
  // and resolveSidebarMode to correctly detect workspace mode from the URL.
  const ctx = { orgSlug };

  return (
    <PageContextProvider>
      <AppShell
        org={org}
        availableOrgs={availableOrgs}
        availableWorkspaces={workspacesRows}
        user={user}
        balance={
          lowBalance
            ? { cents: lowBalance.balanceCents, low: lowBalance.low }
            : null
        }
      >
        {children}
      </AppShell>

      {/* Ask drawer — mounted once at the org shell boundary. */}
      <AskDrawer
        orgSlug={orgSlug}
        availableWorkspaces={workspacesRows}
        modelConfig={resolvedTierCatalog()}
      />

      {/* Command menu — Cmd+K overlay */}
      <CommandMenu ctx={ctx} />

      {/* Fill overlay — renders AI form-fill suggestions from AskBar */}
      <FillOverlay />

      {/* Floating wand AI agent button — fixed bottom-right of the viewport. */}
      <WandButton />

      {/* Wand panel — the AI agent chat drawer triggered by the wand button.
          Mounted once at the org layout boundary so it persists across navigation.
          The panel resolves the active workspace from the URL on each send. */}
      <WandPanel
        orgSlug={orgSlug}
        availableWorkspaces={workspacesRows}
        modelConfig={resolvedTierCatalog()}
      />
    </PageContextProvider>
  );
}
