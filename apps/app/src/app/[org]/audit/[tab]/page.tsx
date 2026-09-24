// Audit's other five tabs (rev1 audit.md, Tabs): Incidents, Receipts,
// Exports, Keys and Retention, each a URL segment under the page (§1.2). A
// segment that names no tab is a 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  Audit,
  AuditHeaderAction,
  AuditRetentionLine,
  AuditSkeleton,
  auditTabOf,
} from "@/features/audit";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("audit") };
}

export default async function AuditTabPage({
  params,
  searchParams,
}: PageProps<"/[org]/audit/[tab]">) {
  const { org, tab: segment } = await params;
  const ctx = await requireViewer(org);
  const tab = auditTabOf(segment);
  if (tab === null) notFound();
  const query = await searchParams;
  const t = await getTranslations("pages");
  const page = await getTranslations("audit");
  return (
    <main
      id="main"
      className="group/audit mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      {/* A state (empty, loading, error, denied) is shown alone, as the
          design draws it: the header stays in the document for its h1 and
          steps out of view. */}
      <div className="group-has-[[data-audit-state]]/audit:sr-only">
        <PageHeader
          title={t("audit")}
          eyebrow={page("eyebrow")}
          description={page("description")}
          meta={
            <Suspense fallback={null}>
              <AuditRetentionLine ctx={ctx} source={dataSource()} />
            </Suspense>
          }
          actions={<AuditHeaderAction org={ctx.orgSlug} />}
        />
      </div>
      <Suspense fallback={<AuditSkeleton />}>
        <Audit ctx={ctx} source={dataSource()} tab={tab} searchParams={query} />
      </Suspense>
    </main>
  );
}
