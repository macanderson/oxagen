import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import {
  assertOrgMember,
  getOrgRole,
  resolveOrgOrRedirect,
} from "@/lib/resolve-org";
import { loadMfaPolicy } from "@/app/[orgSlug]/security/mfa/actions";
import { evaluateMfaGate } from "./mfa-enforcement";

// Sentinel workspaceId for org-only routes (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { planLabelFrom } from "@/lib/plan-label";
import { isLowBalance } from "@oxagen/billing";
import { logger } from "@oxagen/handlers/logger";
import { AppShell } from "@/components/shell/app-shell";
import type { ShellNavData } from "@/components/shell/shell-nav-slots";
import { PageContextProvider } from "@/lib/page-context";
import { CommandMenu } from "@/components/shell/ask/command-menu";
import { FillOverlay } from "@/components/shell/ask/fill-overlay";
import { OrgOnlyMount } from "@/components/shell/ask/org-only-mount";
import { resolvedTierCatalog } from "@oxagen/ai";
import {
  AgentPanelStoreProvider,
  InAppAgentPanel,
} from "@/components/agent-panel";
import type { PlanTier } from "@oxagen/oxagen/types";

type ModelConfig = ReturnType<typeof resolvedTierCatalog>;

/** Agent panel — same deferral as the old WandPanel (overlay, needs the workspace list). */
async function AgentPanelStreamed({
  orgSlug,
  navDataPromise,
  modelConfig,
}: {
  orgSlug: string;
  navDataPromise: Promise<ShellNavData>;
  modelConfig: ModelConfig;
}) {
  const { availableWorkspaces } = await navDataPromise;
  return (
    <InAppAgentPanel
      orgSlug={orgSlug}
      availableWorkspaces={availableWorkspaces}
      modelConfig={modelConfig}
    />
  );
}

// Pull the pathname + search off whatever URL form Next.js handed us. The
// header value may be a full URL ("https://host/path?q") or a path-only string
// ("/path?q") — both are valid inputs to URL with a base. Falls back to a bare
// org root when parsing fails (defensive — prevents a malformed header from
// 500-ing the layout).
function parseRequestUrl(
  raw: string,
  orgSlug: string,
): { pathname: string; search: string } {
  try {
    const u = new URL(raw, "http://internal.local");
    return { pathname: u.pathname, search: u.search };
  } catch {
    return { pathname: `/${orgSlug}`, search: "" };
  }
}

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug } = await params;
  // Surface the current request URL so the resolver can build a 308 redirect
  // to the canonical slug, preserving the rest of the path and the query.
  // Next.js exposes the URL on the synthetic `x-url` / `next-url` header in
  // RSC; we fall back to a bare org root if neither is present (defensive —
  // production always sets one).
  const hdrs = await headers();
  const rawUrl =
    hdrs.get("x-url") ??
    hdrs.get("next-url") ??
    hdrs.get("x-invoke-path") ??
    `/${orgSlug}`;
  const { pathname, search } = parseRequestUrl(rawUrl, orgSlug);
  const org = await resolveOrgOrRedirect(orgSlug, pathname, search);
  // Tenant isolation: gate EVERY org-scoped page on membership. Without this
  // an authenticated user could read any org's data by guessing the slug
  // (IDOR). Non-members get a 404 via notFound() — indistinguishable from an
  // unknown org. This is the single enforcement point for all [orgSlug] routes.
  await assertOrgMember(org.id, session.user.id);

  // MFA enforcement gate — privileged (owner/admin) users in an org that
  // requires MFA must enroll TOTP once the grace window lapses, or they are
  // redirected to their account security page to set it up. Short-circuit on
  // the common path: only orgs that opted into mfa_required pay for the extra
  // role + enrollment reads. /account/security lives OUTSIDE [orgSlug], so this
  // redirect never loops. — security-hardening
  const mfaPolicy = await loadMfaPolicy(org.id);
  if (mfaPolicy?.mfaRequired) {
    const [role, twoFactorRows] = await Promise.all([
      getOrgRole(org.id, session.user.id),
      withSystemDb((tx) =>
        tx
          .select({ enabled: schema.users.twoFactorEnabled })
          .from(schema.users)
          .where(eq(schema.users.id, session.user.id))
          .limit(1),
      ),
    ]);
    const decision = evaluateMfaGate({
      role,
      twoFactorEnabled: twoFactorRows[0]?.enabled ?? false,
      policy: mfaPolicy,
      now: new Date(),
    });
    if (decision.action === "redirect-enroll") {
      redirect("/account/security?enroll=required");
    }
  }

  // planTier gates which nav items the (immediately-rendered) sidebar shows, so
  // it CANNOT be deferred — fetch just the current org's active-subscription
  // tier with one small indexed query. The heavier org-list join, workspace
  // list, and balance are streamed (navDataPromise) below.
  const planRows = await withSystemDb((tx) =>
    tx
      .select({ tier: schema.plans.tier })
      .from(schema.subscriptions)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
      .where(
        and(
          eq(schema.subscriptions.orgId, org.id),
          eq(schema.subscriptions.status, "active"),
        ),
      )
      .limit(1),
  );
  const planTier = (planRows[0]?.tier ?? "free") as PlanTier;

  // Heavy, non-critical shell data — fetched OFF the layout's critical path so
  // child route segments (and their loading.tsx) paint immediately instead of
  // blocking on this Promise.all. Resolved inside ShellFrame's <Suspense> slots
  // and the overlay wrappers below. — progressive-loading-ux
  const navDataPromise: Promise<ShellNavData> = (async () => {
    const [orgRows, workspacesRows, lowBalance] = await Promise.all([
      // Cross-tenant read: the user's full org list (pre-scope, identity resolution).
      // withSystemDb bypasses RLS deliberately.
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
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.orgUsers.orgId),
          )
          .leftJoin(
            schema.subscriptions,
            and(
              eq(schema.subscriptions.orgId, schema.organizations.id),
              eq(schema.subscriptions.status, "active"),
            ),
          )
          .leftJoin(
            schema.plans,
            eq(schema.plans.id, schema.subscriptions.planId),
          )
          .where(eq(schema.orgUsers.userId, session.user.id)),
      ),
      // Org-scoped workspace list — sentinel workspace id (org_only table).
      runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
        withTenantDb(
          (tx) =>
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
      // billing read never blocks the whole app shell from rendering.
      runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
        isLowBalance(org.id),
      ).catch((err) => {
        logger.warn(
          { err, orgId: org.id },
          "shell: isLowBalance failed — hiding credit pill",
        );
        return null;
      }),
    ]);

    return {
      // Shape the org rows for the picker: a flat { …identity, avatarUrl, planLabel }.
      availableOrgs: orgRows.map((o) => ({
        publicId: o.publicId,
        slug: o.slug,
        name: o.name,
        avatarUrl: o.avatarUrl,
        planLabel: planLabelFrom(o.subscriptionTier, o.planType),
      })),
      availableWorkspaces: workspacesRows,
      balance: lowBalance
        ? { cents: lowBalance.balanceCents, low: lowBalance.low }
        : null,
    };
  })();

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
  const modelConfig = resolvedTierCatalog();

  return (
    <PageContextProvider>
      <AgentPanelStoreProvider>
        <AppShell
          org={org}
          navDataPromise={navDataPromise}
          user={user}
          planTier={planTier}
        >
          {children}
        </AppShell>

        {/*
          CommandMenu at the org boundary serves org-only routes
          (`/{org}`, `/{org}/settings`, `/{org}/members`, …). On workspace pages
          the nested `[workspaceSlug]/layout.tsx` mounts it with the
          full `{orgSlug, workspaceSlug}` context, so `enumerateNavTargets`
          surfaces workspace-scoped routes. `OrgOnlyMount` suppresses the
          copy on workspace paths to keep a single set of overlays in the
          tree (acceptance: "No double-mount of CommandMenu").
        */}
        <OrgOnlyMount orgSlug={orgSlug}>
          <CommandMenu ctx={ctx} />
        </OrgOnlyMount>

        {/* Fill overlay — renders AI form-fill suggestions from AskBar */}
        <FillOverlay />

        {/* Unified in-app agent panel — Linear-style overlay.
            Mounted once at the org layout boundary so it persists across navigation.
            The panel resolves the active workspace from the URL on each send. */}
        <Suspense fallback={null}>
          <AgentPanelStreamed
            orgSlug={orgSlug}
            navDataPromise={navDataPromise}
            modelConfig={modelConfig}
          />
        </Suspense>
      </AgentPanelStoreProvider>
    </PageContextProvider>
  );
}
