import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Spend } from "@/features/spend";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("spend") };
}

// The cost rollup (#2962, ARCHITECTURE.md §1.2); a tab and a drill are query
// values on this one route.
export default async function SpendPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/spend">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const [t, query] = await Promise.all([
    getTranslations("pages"),
    searchParams,
  ]);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("spend")}
      />
      <Spend ctx={ctx} source={dataSource()} searchParams={query} />
    </main>
  );
}
