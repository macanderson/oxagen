/**
 * page.tsx — Workspace → Knowledge → Memory.
 *
 * Server component that resolves auth + org/workspace scope, then renders:
 *   - MemoriesSection: the complete AgentMemory browser (list/CRUD/promote/
 *     bulk-import — pre-existing, renamed from knowledge/memories).
 *   - PromotionQueueSection (new): the full promotion-candidates queue —
 *     every OBSERVATION ripe for promotion, with the explicit
 *     human-confirmation step FACT-type promotions require.
 *   - CitationsSection (new): look up an execution to see which memories it
 *     cited, their influence, and any recorded rule violations.
 *   - EvidenceAttachSection (new): attach corroborating/refuting evidence to
 *     a memory to strengthen (or weaken) its provenance.
 *
 * Each section is its own <Suspense> boundary (via the shared `Section`
 * primitive) so a slow or failing section never blocks its siblings — every
 * section's server-side fetch fails open to an empty/error state rather than
 * throwing (see each _sections/*.tsx file).
 *
 * The memory decay-policy editor is NOT reimplemented here — it lives in
 * Workspace Settings → Agent Defaults; this page links out to it.
 */
import { Suspense } from "react";
import Link from "next/link";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { TableSkeleton } from "@/components/loading";
import {
  Section,
  LoadingState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import { MemoriesSection } from "./memories-section";
import { PromotionQueueSection } from "./_sections/promotion-queue-section";
import { CitationsSection } from "./_sections/citations-section";
import { EvidenceAttachSection } from "./_sections/evidence-attach-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function KnowledgeMemoriesPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  // resolveOrg/resolveWorkspace call notFound() themselves on a miss — they
  // return a non-nullable row or never return at all.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const sectionProps = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    orgSlug,
    workspaceSlug,
  };

  return (
    <div className="flex flex-col gap-8">
      <Suspense fallback={<TableSkeleton rows={8} cols={4} />}>
        <MemoriesSection {...sectionProps} />
      </Suspense>

      <Section fallback={<LoadingState variant="table" />}>
        <PromotionQueueSection {...sectionProps} />
      </Section>

      <Section fallback={<LoadingState variant="detail" />}>
        <CitationsSection orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      </Section>

      <Section fallback={<LoadingState variant="detail" />}>
        <EvidenceAttachSection
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </Section>

      <p className="text-xs text-muted-foreground">
        Memory decay policy (half-life, confidence floor) is managed in{" "}
        <Link
          href={workspace.settings.agentDefaults({ orgSlug, workspaceSlug })}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Workspace Settings → Agent Defaults
        </Link>
        .
      </p>
    </div>
  );
}
