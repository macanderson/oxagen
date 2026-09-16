import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Tools } from "@/features/tools";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("tools") };
}

// The mandates ledger (#2957, ARCHITECTURE.md §1.2); the registry, connections,
// kill switches and auto-approval rules arrive with the #2958 lane.
export default async function ToolsPage({
  params,
}: PageProps<"/[org]/[ws]/tools">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("tools")} />
      <Tools ctx={ctx} source={dataSource()} />
    </main>
  );
}
