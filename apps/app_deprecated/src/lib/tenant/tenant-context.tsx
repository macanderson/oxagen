"use client";
/**
 * tenant-context.tsx — the active org + workspace, globally available to every
 * client component rendered under `[orgSlug]/[workspaceSlug]`.
 *
 * The workspace layout resolves the tenant ONCE per request (server-side, from
 * the URL slugs) and seeds `TenantProvider`. Any client component then calls
 * `useTenant()` and always gets a complete, valid tenant — no prop-drilling,
 * no optional `orgId`/`workspaceId` props, no "active tenant not found".
 *
 *   const { orgId, workspaceId, orgSlug, workspaceSlug } = useTenant();
 *
 * `useTenant()` throws if used outside a workspace route — that throw is the
 * signal you are rendering tenant-scoped UI somewhere it cannot be scoped.
 * Use `useTenantOptional()` for components that may also render unscoped.
 */
import * as React from "react";

export interface ActiveTenant {
  orgId: string;
  orgSlug: string;
  orgName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}

const TenantContext = React.createContext<ActiveTenant | null>(null);
TenantContext.displayName = "TenantContext";

export function TenantProvider({
  value,
  children,
}: {
  value: ActiveTenant;
  children: React.ReactNode;
}) {
  // The value is resolved once per request and stable for the route's lifetime;
  // memoize on the primitive ids so context identity only changes on navigation.
  const memo = React.useMemo<ActiveTenant>(
    () => value,
    // Intentional: memoize on the primitive ids (per the comment above) so context
    // identity only changes on navigation, not on every new `value` object reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      value.orgId,
      value.orgSlug,
      value.orgName,
      value.workspaceId,
      value.workspaceSlug,
      value.workspaceName,
    ],
  );
  return (
    <TenantContext.Provider value={memo}>{children}</TenantContext.Provider>
  );
}

/** The active org+workspace. Throws if used outside a workspace route. */
export function useTenant(): ActiveTenant {
  const ctx = React.useContext(TenantContext);
  if (!ctx) {
    throw new Error(
      "useTenant() must be used within a workspace route — TenantProvider is mounted by app/[orgSlug]/[workspaceSlug]/layout.tsx.",
    );
  }
  return ctx;
}

/** Non-throwing variant for components that may render outside a workspace route. */
export function useTenantOptional(): ActiveTenant | null {
  return React.useContext(TenantContext);
}
