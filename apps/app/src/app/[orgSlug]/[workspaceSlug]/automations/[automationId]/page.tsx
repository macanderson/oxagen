/**
 * page.tsx — Workspace → Automations → one automation (editor + detail).
 *
 * Where an admin does the real governance work the list only summarizes: edit
 * the trigger, review run history for audit, and toggle enablement behind the
 * human confirm gate. Server component — resolves scope, reads the full
 * automation via automation.get (name, description, trigger config, steps, and
 * recent runs), and renders the editor. A not-found id 404s.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import { getAutomation } from "@/lib/automations/automations";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";
import { EditorHeader } from "./_components/editor-header";
import { TriggerConfigPanel } from "./_components/trigger-config-panel";
import { PlaybookSteps } from "./_components/playbook-steps";
import { RunHistory } from "./_components/run-history";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; automationId: string }>;
}

export const metadata: Metadata = { title: "Automation" };

export default async function AutomationDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, automationId } = await params;
  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);

  let automation: AutomationGetOutput;
  try {
    automation = await getAutomation(ctx, automationId);
  } catch (err) {
    // A missing / cross-tenant automation resolves to 404, not a thrown error page.
    console.error("automation.get failed:", err);
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <EditorHeader
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        automation={automation}
        canManage={canManage}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <TriggerConfigPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          automationId={automation.automation_id}
          triggerType={automation.triggerType}
          triggerConfig={automation.triggerConfig}
          canManage={canManage}
        />
        <PlaybookSteps steps={automation.steps} />
      </div>

      <RunHistory runs={automation.runs} />
    </div>
  );
}
