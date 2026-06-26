import { Zap } from "lucide-react";
import { listTriggersAction } from "@/lib/actions/triggers";
import { TriggersPanel } from "./triggers-panel";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AutomationTriggersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ agentId?: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const { agentId } = await searchParams;

  // If an agentId is provided, use the capability to list its triggers
  if (agentId) {
    const data = await listTriggersAction({
      orgSlug,
      workspaceSlug,
      agentId,
    }).catch(() => ({
      triggers: [],
    }));

    return (
      <TriggersPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        agentId={agentId}
        agentName={agentId}
        triggers={data.triggers}
      />
    );
  }

  // Otherwise show a workspace-wide view prompting agent selection
  // List agents that have triggers configured
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  const agentTriggers = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({
            id: schema.agentTriggers.id,
            publicId: schema.agentTriggers.publicId,
            agentId: schema.agentTriggers.agentId,
            triggerType: schema.agentTriggers.triggerType,
            eventSource: schema.agentTriggers.eventSource,
            eventType: schema.agentTriggers.eventType,
            connectionId: schema.agentTriggers.connectionId,
            filter: schema.agentTriggers.filter,
            schedule: schema.agentTriggers.schedule,
            enabled: schema.agentTriggers.enabled,
          })
          .from(schema.agentTriggers)
          .where(
            and(
              eq(schema.agentTriggers.workspaceId, ws.id),
              isNull(schema.agentTriggers.deletedAt),
            ),
          )
          .orderBy(desc(schema.agentTriggers.createdAt))
          .limit(50),
      ),
  ).catch(
    () =>
      [] as {
        id: string;
        publicId: string;
        agentId: string;
        triggerType: string;
        eventSource: string | null;
        eventType: string | null;
        connectionId: string | null;
        filter: unknown;
        schedule: string | null;
        enabled: boolean;
      }[],
  );

  const triggers = agentTriggers.map((t) => ({
    triggerId: t.id,
    publicId: t.publicId,
    triggerType: t.triggerType as "manual" | "schedule" | "event",
    eventSource: t.eventSource,
    eventType: t.eventType,
    connectionId: t.connectionId,
    filter: (t.filter ?? {}) as Record<string, unknown>,
    schedule: t.schedule,
    enabled: t.enabled,
  }));

  // Use the first agent's ID if triggers exist, or a placeholder
  const firstAgentId = agentTriggers[0]?.agentId ?? "";

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {triggers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Zap
            className="h-8 w-8 text-muted-foreground/50"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-foreground">
              No triggers configured
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Triggers automate agent runs on a schedule or in response to
              events. Create an agent first, then add triggers from its
              configuration page.
            </p>
          </div>
        </div>
      ) : (
        <TriggersPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          agentId={firstAgentId}
          agentName="Workspace triggers"
          triggers={triggers}
        />
      )}
    </div>
  );
}
