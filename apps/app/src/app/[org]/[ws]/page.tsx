import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { FleetSpendTiles } from "@/features/spend";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("fleet") };
}

// The title and the cost rollup's two tiles (#2962) until WL-34 builds the
// rest of the Fleet page (ARCHITECTURE.md §8).
export default async function FleetPage({ params }: PageProps<"/[org]/[ws]">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("fleet")} />
      <FleetSpendTiles ctx={ctx} source={dataSource()} />
    </main>
  );
}
