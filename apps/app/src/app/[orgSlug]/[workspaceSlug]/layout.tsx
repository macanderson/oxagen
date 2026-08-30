import { headers } from "next/headers";
import {
  assertWorkspaceMember,
  resolveOrg,
  resolveWorkspaceOrRedirect,
} from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { TenantProvider } from "@/lib/tenant/tenant-context";
import { CommandMenu } from "@/components/shell/ask/command-menu";

// Local mirror of parseRequestUrl in [orgSlug]/layout.tsx. Inlined (not
// exported) because the two layouts are the only callers and bouncing through
// a tiny shared helper for ~6 lines adds more indirection than it removes.
function parseRequestUrl(
  raw: string,
  orgSlug: string,
  workspaceSlug: string,
): { pathname: string; search: string } {
  try {
    const u = new URL(raw, "http://internal.local");
    return { pathname: u.pathname, search: u.search };
  } catch {
    return { pathname: `/${orgSlug}/${workspaceSlug}`, search: "" };
  }
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug } = await params;
  const tenant = await resolveOrg(orgSlug);
  // Workspace slug redirect: when the URL's workspace slug is a stale entry in
  // workspace_slug_history, the resolver throws a 308 to the canonical URL
  // with the rest of the path + query preserved. The org slug is resolved one
  // layer up ([orgSlug]/layout.tsx) — if it was stale the redirect already
  // fired before this layout ran, so the orgSlug here is always canonical.
  const hdrs = await headers();
  const rawUrl = hdrs.get("x-url") ?? `/${orgSlug}/${workspaceSlug}`;
  const { pathname, search } = parseRequestUrl(rawUrl, orgSlug, workspaceSlug);
  const workspace = await resolveWorkspaceOrRedirect(
    tenant.id,
    tenant.slug,
    workspaceSlug,
    pathname,
    search,
  );
  // Tenant isolation: gate every workspace-scoped page on workspace membership.
  // Without this, any org member can read another workspace's data within the
  // same org by guessing the workspace slug (IDOR). Non-members get a 404 via
  // notFound() — consistent with assertOrgMember above.
  await assertWorkspaceMember(workspace.id, session.user.id);

  // Workspace-scoped CommandMenu mount.
  //
  // The org layout also mounts this overlay, but with only `{orgSlug}`
  // context — which causes `enumerateNavTargets` to omit every workspace
  // route (Knowledge, Workbench, Settings, …). Mounting here with the full
  // `{orgSlug, workspaceSlug}` ctx restores the workspace nav surface on
  // `/{org}/{ws}/...` paths. `OrgOnlyMount` in the parent layout suppresses
  // the org-only copy on workspace paths so only one set renders.
  const ctx = { orgSlug, workspaceSlug };

  // Seed the active tenant once so every client component under this route can
  // read it via useTenant() — no prop-drilling of orgId/workspaceId.
  return (
    <TenantProvider
      value={{
        orgId: tenant.id,
        orgSlug: tenant.slug,
        orgName: tenant.name,
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        workspaceName: workspace.name,
      }}
    >
      {children}
      <CommandMenu ctx={ctx} />
    </TenantProvider>
  );
}
