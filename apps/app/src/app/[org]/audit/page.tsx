import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Audit, AuditSkeleton } from "@/features/audit";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("audit") };
}

export default async function AuditPage({
  params,
  searchParams,
}: PageProps<"/[org]/audit">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const query = await searchParams;
  const t = await getTranslations("pages");
  const page = await getTranslations("audit");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        title={t("audit")}
        eyebrow={page("eyebrow")}
        description={page("description")}
      />
      <Suspense fallback={<AuditSkeleton />}>
        <Audit ctx={ctx} source={dataSource()} searchParams={query} />
      </Suspense>
    </main>
  );
}
