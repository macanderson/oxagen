"use client";

import { PageTabs } from "@/components/ui/page-tabs";
import { cn } from "@/lib/utils";

/**
 * TabStrip — Phase-0 thin wrapper around `@/components/ui/page-tabs`.
 *
 * Does not reimplement tab logic: `PageTabs` already resolves the active tab
 * by longest-prefix match against the current pathname (see
 * `@/lib/resolve-active-tab`).
 */
export interface TabStripTab {
  label: string;
  href: string;
  badge?: number | null;
}

export interface TabStripProps {
  tabs: TabStripTab[];
  className?: string;
}

export function TabStrip({ tabs, className }: TabStripProps) {
  return <PageTabs tabs={tabs} className={cn(className)} />;
}
