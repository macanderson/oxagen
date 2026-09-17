/**
 * promotion-queue-section.tsx — async Server Component.
 *
 * Fetches the full promotion-candidates queue via agent.memory.promotion.
 * candidates ("list_memory_promotions") so it can stream into its own
 * <Suspense> boundary alongside the other Knowledge → Memory sections. This
 * is a fuller, dedicated view than the inline "Suggested to promote" nudge
 * already built into MemoriesClient (which shows only the top 3 via the same
 * capability) — the queue below shows up to the API's cap (25 — see
 * agent.memory_promotion.list) and is the explicit human-confirmation surface
 * spec.md calls out, especially for FACT-type promotions.
 *
 * Fails open: a fetch error is captured and passed down as `loadError` rather
 * than thrown — the section renders (with an error state) instead of taking
 * down the rest of the page.
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import type { AgentMemoryPromotionCandidatesOutput } from "@oxagen/oxagen/contracts/agent.memory_promotion.list";
import { MemoryPromotionQueue } from "@/components/knowledge/memories/memory-promotion-queue";
import {
  promoteMemoryAction,
  dismissPromotionAction,
  suggestRationalesAction,
} from "../actions";

interface PromotionQueueSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

// agent.memory_promotion.list caps `limit` at 25 (input schema: max(25)).
const QUEUE_LIMIT = 25;

export async function PromotionQueueSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: PromotionQueueSectionProps) {
  let candidates: AgentMemoryPromotionCandidatesOutput["candidates"] = [];
  let loadError: string | null = null;

  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "list_memory_promotions",
        { limit: QUEUE_LIMIT },
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
    )) as AgentMemoryPromotionCandidatesOutput;
    candidates = result.candidates;
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId },
      "knowledge.memory: list_memory_promotions failed",
    );
    loadError =
      err instanceof Error
        ? err.message
        : "Failed to load promotion candidates.";
  }

  return (
    <MemoryPromotionQueue
      initialCandidates={candidates}
      loadError={loadError}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      promoteMemory={promoteMemoryAction}
      dismissPromotion={dismissPromotionAction}
      suggestRationales={suggestRationalesAction}
    />
  );
}
