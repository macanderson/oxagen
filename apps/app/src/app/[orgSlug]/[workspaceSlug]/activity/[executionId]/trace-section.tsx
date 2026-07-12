/**
 * trace-section.tsx — async server component that fetches one run's span tree
 * via agent.trace.get and renders <SpanTree>. Renders a clear "not found" card
 * when the execution is unknown or cross-tenant (never throws from the RSC).
 *
 * When the resolved trace's root status is "failed", also renders the
 * structured failure frame (<DebugSection>, agent.debug.trace) ABOVE the span
 * tree — per the run-detail spec, the debug panel comes first so a failed run
 * leads with "why", not a raw tree. DebugSection gets its own Suspense
 * boundary so its (separate) invoke() never blocks the span tree that's
 * already resolved here.
 *
 * Auth note: apps/app does NOT bootstrap IAM (invoke() skips role checks); the
 * page already gated org membership. agent.trace.get is surfaces
 * ["api","mcp","agent"] — pass surface "agent".
 */
import { Suspense } from "react";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentTraceGetOutput } from "@oxagen/oxagen/contracts/agent.trace.get";
import { SpanTree } from "@/components/activity/span-tree";
import { Skeleton } from "@/components/ui/skeleton";
import { DebugSection } from "./debug-section";

interface TraceSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  executionId: string;
}

export async function TraceSection({
  orgId,
  workspaceId,
  userId,
  executionId,
}: TraceSectionProps) {
  let trace: AgentTraceGetOutput | null = null;
  try {
    trace = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "get_execution_trace",
        { executionId },
        {
          orgId,
          workspaceId,
          userId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        },
        { surface: "agent" },
      ),
    )) as AgentTraceGetOutput;
  } catch (e) {
    // execution_not_found (unknown / cross-tenant) or any transient failure —
    // render the not-found card rather than throwing from the RSC.
    console.error("agent.trace.get failed:", e);
  }

  if (!trace) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This run could not be found. It may have been purged or belongs to a
          different workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {trace.status === "failed" ? (
        <Suspense
          fallback={
            <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          }
        >
          <DebugSection
            orgId={orgId}
            workspaceId={workspaceId}
            userId={userId}
            executionId={trace.executionId}
          />
        </Suspense>
      ) : null}
      <SpanTree trace={trace} />
    </div>
  );
}
