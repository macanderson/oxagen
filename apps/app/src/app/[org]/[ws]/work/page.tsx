import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { parseWorkTab, WorkLoading, WorkPage } from "@/features/work";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("work") };
}

// Work (agent-work-phase-1.html, Screens; roadmap mockups/pages/work.md): every
// work item from the moment it arrives to the moment a person accepts it and
// its pull request merges. The tab is `?tab=`: Inbox (left off), Running,
// Review, and Done.
export default async function WorkRoute({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  const tab = parseWorkTab(firstParam(query.tab));
  return (
    <Suspense fallback={<WorkLoading />}>
      <WorkPage ctx={ctx} source={dataSource()} tab={tab} />
    </Suspense>
  );
}
