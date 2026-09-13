/**
 * citations-section.tsx — thin Server Component wrapper.
 *
 * agent.memory_citation.list ("list_memory_citations") is scoped to a single
 * executionId supplied by the caller — there is no default/page-load key to
 * prefetch — so this section has no async work of its own. It just crosses
 * the listMemoryCitationsAction server-action ref into the client panel that
 * runs the lookup on demand. Still wrapped in its own <Suspense> boundary
 * from page.tsx for uniformity with the other new sections.
 */
import { MemoryCitationsPanel } from "@/components/knowledge/memories/memory-citations-panel";
import { listMemoryCitationsAction } from "../actions";

interface CitationsSectionProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function CitationsSection({
  orgSlug,
  workspaceSlug,
}: CitationsSectionProps) {
  return (
    <MemoryCitationsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      listCitations={listMemoryCitationsAction}
    />
  );
}
