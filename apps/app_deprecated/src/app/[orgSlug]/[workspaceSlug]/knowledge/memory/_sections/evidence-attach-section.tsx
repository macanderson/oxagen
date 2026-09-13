/**
 * evidence-attach-section.tsx — thin Server Component wrapper.
 *
 * agent.memory_evidence.attach ("attach_memory_evidence") is a write with no
 * list to prefetch, so this section has no async work of its own — it just
 * crosses the attachMemoryEvidenceAction server-action ref into the client
 * form. Still wrapped in its own <Suspense> boundary from page.tsx for
 * uniformity with the other new sections.
 */
import { MemoryEvidenceAttachForm } from "@/components/knowledge/memories/memory-evidence-attach-form";
import { attachMemoryEvidenceAction } from "../actions";

interface EvidenceAttachSectionProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function EvidenceAttachSection({
  orgSlug,
  workspaceSlug,
}: EvidenceAttachSectionProps) {
  return (
    <MemoryEvidenceAttachForm
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      attachEvidence={attachMemoryEvidenceAction}
    />
  );
}
