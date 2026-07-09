/**
 * pending-inferences-section.tsx — async Server Component.
 *
 * Fetches semantic.edge.suggest in isolation so it can stream into its own
 * <Suspense> boundary concurrently with the other sections on the Knowledge →
 * Graph page.
 */
import "@oxagen/handlers/register";
import { Layers } from "lucide-react";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { SemanticEdgeSuggestOutput } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import { InferencePendingList } from "@/components/knowledge/graph/inference-pending-list";

interface PendingInferencesSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export async function PendingInferencesSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: PendingInferencesSectionProps) {
  let pendingSuggestions: SemanticEdgeSuggestOutput["suggestions"] = [];
  let pendingTotal = 0;

  try {
    const result = (await runInTenantScope(
      { orgId, workspaceId },
      () =>
        invoke(
          "suggest_semantic_edges",
          { limit: 50 },
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
    )) as SemanticEdgeSuggestOutput;
    pendingSuggestions = result.suggestions;
    pendingTotal = result.total;
  } catch (e) {
    console.error("semantic.edge.suggest failed:", e);
  }

  return (
    <section aria-labelledby="pending-inferences-heading">
      <div className="mb-4 flex items-center gap-2">
        <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2
          id="pending-inferences-heading"
          className="text-sm font-semibold text-foreground"
        >
          Pending Inferences
        </h2>
        {pendingTotal > 0 && (
          <span className="inline-flex items-center rounded-full bg-warning/12 px-2 py-0.5 text-[10px] font-semibold text-warning">
            {pendingTotal}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        These relationship candidates were inferred by the LLM during ingestion. Review and
        approve edges to materialise them permanently in the knowledge graph.
      </p>
      <InferencePendingList
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialSuggestions={pendingSuggestions}
        total={pendingTotal}
      />
    </section>
  );
}
