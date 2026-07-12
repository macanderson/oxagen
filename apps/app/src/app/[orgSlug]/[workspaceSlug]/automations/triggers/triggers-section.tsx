/**
 * triggers-section.tsx — async server component that fans agent.trigger.list
 * out across every agent in the workspace (via listWorkspaceTriggers) and
 * renders the client table. Sits inside the page's Suspense boundary so the
 * header + tab strip paint first.
 *
 * Never throws on a whole-fan-out failure (list_agent_defs itself rejecting,
 * or resolveAutomationsScope throwing): catches and renders an inline error
 * banner instead of letting the RSC throw bubble to the route error boundary
 * and blank the whole section. Per-agent list_triggers failures are already
 * tolerated inside listWorkspaceTriggers (Promise.allSettled) and surfaced as
 * `failedAgents`, not an exception — the table renders a partial-failure
 * banner for those instead.
 */
import { AlertCircle } from "lucide-react";
import { listWorkspaceTriggers } from "@/lib/automations/triggers";
import { TriggersTable } from "./_components/triggers-table";

export interface TriggersSectionProps {
  orgSlug: string;
  workspaceSlug: string;
}

export async function TriggersSection({ orgSlug, workspaceSlug }: TriggersSectionProps) {
  // Only the await lives in the try — constructing JSX inside a try/catch is a
  // lint error (React renders lazily, so render-time throws escape the catch
  // anyway; render-path failures belong to the route error boundary).
  let result: Awaited<ReturnType<typeof listWorkspaceTriggers>>;
  try {
    result = await listWorkspaceTriggers(orgSlug, workspaceSlug);
  } catch (err) {
    console.error("triggers: listWorkspaceTriggers failed:", err);
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-error/25 bg-error/10 p-3 text-sm text-error"
        role="alert"
      >
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        Couldn’t load the trigger board. Reload the page to try again.
      </div>
    );
  }

  const { rows, failedAgents, canManage } = result;
  return (
    <TriggersTable
      rows={rows}
      failedAgents={failedAgents}
      canManage={canManage}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
