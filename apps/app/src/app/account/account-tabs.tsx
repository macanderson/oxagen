"use client";

/**
 * AccountTabs — the shared tab strip chrome across the four /account/* pages
 * (Profile, Preferences, Security, Privacy).
 *
 * Extracted from layout.tsx into its own presentational component so it's
 * unit-testable without pulling in the layout's withSystemDb/session reads —
 * see account-tabs.test.tsx.
 */
import { TabStrip } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { account } from "@/lib/routes";

const ACCOUNT_TABS = [
  { label: "Profile", href: account.profile() },
  { label: "Preferences", href: account.preferences() },
  { label: "Security", href: account.security() },
  { label: "Privacy", href: account.privacy() },
];

export function AccountTabs() {
  return (
    <div data-testid="account-tab-strip" className="mb-6 flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Account settings
      </span>
      <TabStrip tabs={ACCOUNT_TABS} />
    </div>
  );
}
