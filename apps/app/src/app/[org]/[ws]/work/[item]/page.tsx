import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { WorkItemLoading, WorkItemPage } from "@/features/work";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; ws: string; item: string }>;
}): Promise<Metadata> {
  const { item } = await params;
  const t = await getTranslations("pages");
  return { title: `${item} · ${t("workItem")}` };
}

// One work item (roadmap mockups/pages/work-item.md): where a person decides
// what happens to it. The segment is the workspace's number for the item, such
// as WI-12. `?dialog=send` opens the Send dialog on arrival, which is how the
// Work page's Send buttons reach it.
export default async function WorkItemRoute({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string; item: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws, item } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  const dialog = firstParam(query.dialog) === "send" ? "send" : null;
  return (
    <Suspense fallback={<WorkItemLoading />}>
      <WorkItemPage ctx={ctx} source={dataSource()} item={item} dialog={dialog} />
    </Suspense>
  );
}
