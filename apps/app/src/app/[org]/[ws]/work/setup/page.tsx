import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { parseSetupTab, WorkLoading, WorkSetupPage } from "@/features/work";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("workSetup") };
}

// Work setup (roadmap mockups/pages/work-setup.md): the GitHub collector and
// manual entry, the priorities record triage ranks by, and which agents can
// take a send. The tab is `?tab=`: Collectors (left off), Priorities, Runtimes.
export default async function WorkSetupRoute({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  const tab = parseSetupTab(firstParam(query.tab));
  return (
    <Suspense fallback={<WorkLoading />}>
      <WorkSetupPage ctx={ctx} source={dataSource()} tab={tab} />
    </Suspense>
  );
}
