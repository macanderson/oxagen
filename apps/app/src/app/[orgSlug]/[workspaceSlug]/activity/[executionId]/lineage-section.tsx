/**
 * lineage-section.tsx — async server component that fetches one run's file-level
 * lineage via `agent.execution.lineage` and renders it on the shared knowledge
 * graph canvas (`<ExecutionLineageCanvas>`). Renders nothing when the run has no
 * recorded `TOUCHED_FILE` lineage (e.g. a chat/read-only turn that edited no
 * files), so the trace page stays clean.
 *
 * Auth note: apps/app does NOT bootstrap IAM (invoke() skips role checks); the
 * page already gated org membership. agent.execution.lineage is surfaces
 * ["api","mcp","agent"] — pass surface "agent" (mirrors trace-section.tsx).
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentExecutionLineageOutput } from "@oxagen/oxagen/contracts/agent.execution.lineage";
import { ExecutionLineageCanvas } from "@/components/activity/execution-lineage-canvas";

interface LineageSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  executionId: string;
}

export async function LineageSection({
  orgId,
  workspaceId,
  userId,
  executionId,
}: LineageSectionProps) {
  let lineage: AgentExecutionLineageOutput | null = null;
  try {
    lineage = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "agent.execution.lineage",
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
    )) as AgentExecutionLineageOutput;
  } catch (e) {
    // Unknown / cross-tenant execution or a transient failure — render nothing
    // rather than throwing from the RSC. The trace itself already renders above.
    console.error("agent.execution.lineage failed:", e);
  }

  // No graph lineage recorded for this run (read-only / chat turn, or files not
  // yet materialised) → render nothing.
  if (
    !lineage ||
    !lineage.found ||
    !lineage.execution ||
    lineage.files.length === 0
  ) {
    return null;
  }

  return (
    <ExecutionLineageCanvas
      execution={lineage.execution}
      files={lineage.files}
    />
  );
}
