/**
 * automations-header.tsx — shared page header + tab strip for the Automations
 * cluster (Automations · Triggers · Workflows).
 *
 * Server-safe: composes the client `PageHeader` + `PageTabs` primitives but
 * holds no state itself, so both the list/triggers/workflows server pages can
 * render it. The single-automation editor (`[automationId]`) renders its own
 * header instead — it is a detail view below the tab strip, not one of the tabs.
 *
 * `PageTabs` resolves the active tab by longest-prefix pathname match, so no
 * explicit active flag is needed; `actions` slots in a page-specific primary
 * action (e.g. the list page's "New automation" button).
 */
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export interface AutomationsHeaderProps {
  ctx: Required<ScopeContext>;
  title?: string;
  description?: string;
  actions?: ReactNode;
}

export function AutomationsHeader({
  ctx,
  title,
  description,
  actions,
}: AutomationsHeaderProps) {
  const tabs = [
    { label: "Automations", href: workspace.automations.root(ctx) },
    { label: "Triggers", href: workspace.automations.triggers(ctx) },
    { label: "Workflows", href: workspace.automations.workflows(ctx) },
    { label: "Lineage", href: workspace.automations.lineage(ctx) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title={title ?? "Automations"}
        description={
          description ??
          "Human-gated agent automations — playbooks bound to an event, schedule, or manual trigger, with an audited run history."
        }
        actions={actions}
      />
      <PageTabs tabs={tabs} />
    </div>
  );
}
