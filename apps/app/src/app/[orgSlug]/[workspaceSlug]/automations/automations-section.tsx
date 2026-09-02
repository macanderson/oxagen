/**
 * automations-section.tsx — async server component that loads every automation
 * in the workspace via automation.list and renders the client table. Sits
 * inside the page's Suspense boundary so the header + tab strip paint first.
 *
 * Never throws: on failure it renders the error banner inline (an RSC throw
 * would bubble to the route error boundary and blank the whole section).
 */
import { AlertCircle } from "lucide-react";
import { logger } from "@oxagen/handlers/logger";
import type { AutomationsCtx } from "@/lib/automations/scope";
import { listAutomations } from "@/lib/automations/automations";
import type { AutomationListOutput } from "@oxagen/oxagen/contracts/automation.list";
import { AutomationsTable } from "./_components/automations-table";

export interface AutomationsSectionProps {
  ctx: AutomationsCtx;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

export async function AutomationsSection({
  ctx,
  orgSlug,
  workspaceSlug,
  canManage,
}: AutomationsSectionProps) {
  let automations: AutomationListOutput = [];
  let failed = false;
  try {
    automations = await listAutomations(ctx);
  } catch (err) {
    failed = true;
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "automations: automation.list failed",
    );
  }

  if (failed) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-error/25 bg-error/10 p-3 text-sm text-error"
        role="alert"
      >
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        Couldn’t load automations. Reload the page to try again.
      </div>
    );
  }

  return (
    <AutomationsTable
      automations={automations}
      canManage={canManage}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
