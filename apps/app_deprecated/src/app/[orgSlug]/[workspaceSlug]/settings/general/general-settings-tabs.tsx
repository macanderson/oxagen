"use client";

/**
 * GeneralSettingsTabs — client wrapper providing the in-page "General" /
 * "Members" sub-tabs for Workspace → Settings → General.
 *
 * Both panels are rendered server-side up front (the parent Server Component
 * fetches both the general-settings row AND the members list in parallel) and
 * passed in as fully-resolved `ReactNode`s — switching tabs is a pure client
 * toggle, no re-fetch. The active tab is mirrored to the `?tab=` search param
 * so the view is linkable/shareable and survives a reload; `workspace.settings.
 * members(ctx)` (see @/lib/routes) already resolves to `.../settings/general
 * ?tab=members`, so this component's URL shape matches routes.ts by
 * construction. "general" is the default tab and intentionally has NO query
 * param (mirrors `workspace.settings.general(ctx)`, which is the bare path).
 *
 * Pattern: Base UI Tabs (`@/components/ui/tabs`) driven as a controlled
 * component, with the active tab synced to the URL.
 */
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
  TabsIndicator,
} from "@/components/ui/tabs";

export type GeneralSettingsTab = "general" | "members";

export interface GeneralSettingsTabsProps {
  initialTab: GeneralSettingsTab;
  generalPanel: React.ReactNode;
  membersPanel: React.ReactNode;
}

export function GeneralSettingsTabs({
  initialTab,
  generalPanel,
  membersPanel,
}: GeneralSettingsTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = React.useState<GeneralSettingsTab>(initialTab);

  function handleTabChange(value: unknown) {
    const next = value === "members" ? "members" : "general";
    setTab(next);
    // "general" is the default — keep its URL bare (no ?tab=) so the canonical
    // route from @/lib/routes (`workspace.settings.general`) stays the one
    // users land on/share; "members" appends the param.
    router.replace(next === "general" ? pathname : `${pathname}?tab=members`, {
      scroll: false,
    });
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <TabsList variant="underline" className="mb-6 relative">
        <TabsTab value="general">General</TabsTab>
        <TabsTab value="members">Members</TabsTab>
        <TabsIndicator />
      </TabsList>

      <TabsPanel value="general">{generalPanel}</TabsPanel>
      <TabsPanel value="members">{membersPanel}</TabsPanel>
    </Tabs>
  );
}
