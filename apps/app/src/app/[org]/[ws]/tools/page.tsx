import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Tools, ToolsLoading } from "@/features/tools";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("tools") };
}

// The registry, the credential grants and the kill switches (#2958,
// ARCHITECTURE.md §1.2): a tab, a category chip, the names toggle and a cursor
// are query values on this one route, so the lane adds no route.
export default async function ToolsPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/tools">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const [pages, t, query] = await Promise.all([
    getTranslations("pages"),
    getTranslations("tools"),
    searchParams,
  ]);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        title={pages("tools")}
        eyebrow={t("eyebrow", { workspace: ctx.wsName })}
        description={t("lede")}
      />
      <Suspense fallback={<ToolsLoading />}>
        <Tools ctx={ctx} source={dataSource()} searchParams={query} />
      </Suspense>
    </main>
  );
}
