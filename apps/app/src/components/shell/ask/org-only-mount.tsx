"use client";
/**
 * OrgOnlyMount — gates the org-layout's CommandMenu and AskDrawer mounts.
 *
 * The workspace-layout (`/[orgSlug]/[workspaceSlug]/layout.tsx`) mounts its own
 * CommandMenu + AskDrawer with the full `{orgSlug, workspaceSlug}` context so
 * `enumerateNavTargets` includes workspace-scoped routes (Knowledge, Studio,
 * Settings…). Because the workspace layout is nested INSIDE the org layout in
 * Next.js App Router, both overlays would render on workspace pages without a
 * guard — producing duplicate dialogs and ambiguous keyboard focus.
 *
 * This wrapper uses `usePathname()` to detect workspace mode at runtime and
 * suppresses the org-layout's overlay tree when the workspace mount will take
 * over. On org-only paths (`/{org}`, `/{org}/settings`, `/{org}/members`, …)
 * it renders children as-is so Cmd+K and the Ask drawer remain available.
 *
 * The decision uses the same `resolveSidebarMode` predicate the sidebar relies
 * on, so the gate stays in lockstep with the rest of the shell.
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { resolveSidebarMode } from "@/lib/sidebar";

export interface OrgOnlyMountProps {
  orgSlug: string;
  children: React.ReactNode;
}

export function OrgOnlyMount({ orgSlug, children }: OrgOnlyMountProps) {
  const pathname = usePathname();
  const mode = resolveSidebarMode(pathname, { orgSlug });
  if (mode === "workspace") return null;
  return <>{children}</>;
}
