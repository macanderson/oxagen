import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { WorkLoading, WorkOutcomesPage } from "@/features/work";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("workOutcomes") };
}

// Outcomes (roadmap mockups/pages/work-outcomes.md): what the workspace's
// Phase 1 work finished in the last 30 days, with lead time, review touches,
// and the share of cost Oxagen knows.
export default async function WorkOutcomesRoute({
  params,
}: {
  params: Promise<{ org: string; ws: string }>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  return (
    <Suspense fallback={<WorkLoading />}>
      <WorkOutcomesPage ctx={ctx} source={dataSource()} />
    </Suspense>
  );
}
