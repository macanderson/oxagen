/**
 * debug-section.tsx — async server component that fetches the structured
 * failure frame for a failed run via agent.debug.trace (debug_execution) and
 * renders <DebugPanel>. Rendered by <TraceSection> ONLY when the resolved
 * trace's root status is "failed", inside its own Suspense boundary so a
 * slow/failing debug fetch never blocks the span tree above it.
 *
 * Auth note: apps/app does NOT bootstrap IAM (invoke() skips role checks); the
 * page already gated org membership. agent.debug.trace is surfaces
 * ["api","mcp","agent"] — pass surface "agent" (mirrors trace-section.tsx).
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentDebugTraceOutput } from "@oxagen/oxagen/contracts/agent.debug.trace";
import { DebugPanel } from "./debug-panel";

interface DebugSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  executionId: string;
}

export async function DebugSection({
  orgId,
  workspaceId,
  userId,
  executionId,
}: DebugSectionProps) {
  let frame: AgentDebugTraceOutput | null = null;
  try {
    frame = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "debug_execution",
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
    )) as AgentDebugTraceOutput;
  } catch (e) {
    // Never throw from the RSC — the trace/span tree already rendered above;
    // degrade to an inline muted note rather than taking down the page.
    console.error("agent.debug.trace failed:", e);
  }

  if (!frame) {
    return (
      <p className="text-sm text-muted-foreground">Debug data unavailable.</p>
    );
  }

  return <DebugPanel frame={frame} />;
}
