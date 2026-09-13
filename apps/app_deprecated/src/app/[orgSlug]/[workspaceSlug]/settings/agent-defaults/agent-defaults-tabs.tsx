"use client";

/**
 * AgentDefaultsTabs — client wrapper providing the four in-page sub-tabs for
 * Workspace → Settings → Agent Defaults: Models · Budget · Prompts · Memory
 * Policy.
 *
 * All four panels' data is fetched up front by the parent Server Component
 * (in parallel) and passed in as fully-resolved `ReactNode`s, so switching
 * sub-tabs is a pure client toggle — no re-fetch, no flash. The active tab
 * mirrors the `?tab=` search param ("models" is the default and — mirroring
 * `workspace.settings.agentDefaults(ctx)`, the bare path — carries no query
 * param). Each sub-tab keeps its OWN independent save + feedback; there is no
 * cross-tab save.
 *
 * Pattern: Base UI Tabs (`@/components/ui/tabs`) driven as a controlled
 * component with URL sync — same pattern as
 * ../general/general-settings-tabs.tsx.
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
// The type + `?tab=` guard live in a boundary-agnostic (non-"use client")
// sibling so the Server Component page can call the guard without tripping the
// "call a client function from the server" error. See ./agent-defaults-tabs-shared.
import {
  isAgentDefaultsTab,
  type AgentDefaultsTab,
} from "./agent-defaults-tabs-shared";

export interface AgentDefaultsTabsProps {
  initialTab: AgentDefaultsTab;
  modelsPanel: React.ReactNode;
  budgetPanel: React.ReactNode;
  promptsPanel: React.ReactNode;
  memoryPanel: React.ReactNode;
}

export function AgentDefaultsTabs({
  initialTab,
  modelsPanel,
  budgetPanel,
  promptsPanel,
  memoryPanel,
}: AgentDefaultsTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = React.useState<AgentDefaultsTab>(initialTab);

  function handleTabChange(value: unknown) {
    const next: AgentDefaultsTab = isAgentDefaultsTab(value as string)
      ? (value as AgentDefaultsTab)
      : "models";
    setTab(next);
    // "models" is the default — keep its URL bare (no ?tab=) so the canonical
    // route from @/lib/routes (`workspace.settings.agentDefaults`) stays the
    // one users land on/share; the other three sub-tabs append the param.
    router.replace(next === "models" ? pathname : `${pathname}?tab=${next}`, {
      scroll: false,
    });
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <TabsList variant="underline" className="mb-6 relative">
        <TabsTab value="models">Models</TabsTab>
        <TabsTab value="budget">Budget</TabsTab>
        <TabsTab value="prompts">Prompts</TabsTab>
        <TabsTab value="memory">Memory Policy</TabsTab>
        <TabsIndicator />
      </TabsList>

      <TabsPanel value="models">{modelsPanel}</TabsPanel>
      <TabsPanel value="budget">{budgetPanel}</TabsPanel>
      <TabsPanel value="prompts">{promptsPanel}</TabsPanel>
      <TabsPanel value="memory">{memoryPanel}</TabsPanel>
    </Tabs>
  );
}
