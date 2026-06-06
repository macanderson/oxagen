import { eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { AppShell } from "@/components/shell/app-shell";
import { PageContextProvider } from "@/lib/page-context";
import { AskDrawer } from "@/components/shell/ask/ask-drawer";
import { CommandMenu } from "@/components/shell/ask/command-menu";
import { FillOverlay } from "@/components/shell/ask/fill-overlay";
import {
  orgShellSendAction,
  orgShellResolveApprovalAction,
  orgShellResolvePlanAction,
} from "@/app/[orgSlug]/shell-actions";
import type { ResolvedOrg } from "@/lib/resolve-org";
import { resolvedTierCatalog } from "@oxagen/ai";

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionOrRedirect();

  // Fetch the user's org memberships so we can:
  //   1. Give AppShell an org to render (needed for "Back to app" sidebar link).
  //   2. Populate the OrgSwitcher in the topbar.
  // Cross-tenant identity resolution (pre-scope) — withSystemDb bypasses RLS
  // deliberately. — OXA-1515
  const orgsRows = await withSystemDb((tx) =>
    tx
      .select({
        publicId: schema.organizations.publicId,
        slug: schema.organizations.slug,
        name: schema.organizations.name,
        id: schema.organizations.id,
      })
      .from(schema.orgUsers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgUsers.orgId))
      .where(eq(schema.orgUsers.userId, session.user.id)),
  );

  // Use the first org as the shell's "home" org. If the user has no orgs,
  // provide a safe sentinel that satisfies the AppShell prop types.
  const primaryOrg: ResolvedOrg = orgsRows[0]
    ? {
        id: orgsRows[0].id,
        publicId: orgsRows[0].publicId,
        slug: orgsRows[0].slug,
        name: orgsRows[0].name,
      }
    : {
        // Sentinel for new users who haven't joined an org yet.
        id: "",
        publicId: "",
        slug: "",
        name: "",
      };

  const user = {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email,
    image: session.user.image ?? null,
  };

  const ctx = { orgSlug: primaryOrg.slug };

  return (
    <PageContextProvider>
      <AppShell
        org={primaryOrg}
        availableOrgs={orgsRows}
        user={user}
      >
        {children}
      </AppShell>

      {/* Ask drawer — mounted at the account shell boundary. */}
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
