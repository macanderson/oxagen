import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireViewer } from "@/server/viewer";
import { NotRecorded } from "@/ui/not-recorded";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("spend") };
}

// One NotRecorded state until the #2963 lane lands its app half (ARCHITECTURE.md §1.2).
export default async function SpendPage({
  params,
}: PageProps<"/[org]/[ws]/spend">) {
  const { org, ws } = await params;
  await requireViewer(org, ws);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("spend")} />
      <NotRecorded section="spend" />
    </main>
  );
}
