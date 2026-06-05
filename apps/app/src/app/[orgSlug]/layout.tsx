import { eq, and } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { planLabelFrom } from "@/lib/plan-label";
import { AppShell } from "@/components/shell/app-shell";
import { PageContextProvider } from "@/lib/page-context";
import { AskDrawer } from "@/components/shell/ask/ask-drawer";
import { CommandMenu } from "@/components/shell/ask/command-menu";
import { FillOverlay } from "@/components/shell/ask/fill-overlay";
import {
  orgShellSendAction,
  orgShellResolveApprovalAction,
  orgShellResolvePlanAction,
} from "./shell-actions";
import { resolvedTierCatalog } from "@oxagen/ai";

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

  const [orgRows, workspacesRows] = await Promise.all([
    // Orgs the user belongs to, enriched for the org picker: avatar + the
    // active subscription's plan tier (LEFT JOINed, so a single query covers all
    // the user's orgs — no per-org billing round-trip). At most one active
    // subscription per org (partial unique index), so the join can't multiply
    // rows. Tier falls back to the legacy plan_type, then "free", in plan-label.
    db()
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
    db()
      .select({
        publicId: schema.workspaces.publicId,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.orgId, org.id)),
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
      >
        {children}
      </AppShell>

      {/* Ask drawer — mounted once at the org shell boundary. */}
      <AskDrawer
        ctx={ctx}
        sendAction={orgShellSendAction}
        resolveApprovalAction={orgShellResolveApprovalAction}
        resolvePlanAction={orgShellResolvePlanAction}
        modelConfig={resolvedTierCatalog()}
      />

      {/* Command menu — Cmd+K overlay */}
      <CommandMenu ctx={ctx} />

      {/* Fill overlay — renders AI form-fill suggestions from AskBar */}
      <FillOverlay />
    </PageContextProvider>
  );
}
