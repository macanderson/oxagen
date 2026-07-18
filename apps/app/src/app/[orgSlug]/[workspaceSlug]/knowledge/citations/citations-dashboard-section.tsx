/**
 * citations-dashboard-section.tsx — Async server component that fetches
 * workspace-wide citation analytics via agent.memory_citation.stats
 * ("get_citation_stats") and renders the CitationsDashboard.
 *
 * Sits inside a <Suspense> boundary (see page.tsx) so the page shell paints
 * immediately behind CitationsDashboardSkeleton. The handler for this
 * capability may not exist yet in every environment (built in parallel) — the
 * fetch fails open to an ErrorState rather than throwing, matching every
 * other Knowledge → Memory section (memories-section.tsx, promotion-queue-
 * section.tsx).
 */
import "@oxagen/handlers/register";
// agent.memory_citation.stats is an agent.* capability — its handler is bound
// by @oxagen/agent/register, NOT the foundation register. Without this the
// kernel throws "No handler registered for capability get_citation_stats" at
// runtime.
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentMemoryCitationStatsOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import { CitationsDashboard } from "@/components/knowledge/citations/citations-dashboard";
import type { DayPreset } from "./citations-format";

const TOP_N_LIMIT = 10;

interface CitationsDashboardSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  days: DayPreset;
}

export async function CitationsDashboardSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  days,
}: CitationsDashboardSectionProps) {
  let data: AgentMemoryCitationStatsOutput | null = null;
  let loadFailed = false;

  try {
    data = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "get_citation_stats",
        { days, limit: TOP_N_LIMIT },
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
    )) as AgentMemoryCitationStatsOutput;
  } catch (e) {
    console.error("agent.memory_citation.stats failed:", e);
    // A fetch failure is not "no citations yet" — surface it as an error
    // (never throw from RSC, which would blank the streamed header) rather
    // than masquerading the failure as the dashboard's empty state.
    loadFailed = true;
  }

  if (loadFailed || !data) {
    return (
      <ErrorState
        title="Couldn't load citation analytics"
        description="Something went wrong loading citation analytics. Reload the page to try again."
      />
    );
  }

  return (
    <CitationsDashboard
      data={data}
      windowDays={days}
      memoryPageHref={workspace.knowledge.memory({ orgSlug, workspaceSlug })}
    />
  );
}
