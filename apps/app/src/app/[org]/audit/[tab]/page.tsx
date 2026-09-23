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
}: PageProps<"/[org]/audit/[tab]">) {
  const { org, tab: segment } = await params;
  const ctx = await requireViewer(org);
  const tab = auditTabOf(segment);
  if (tab === null) notFound();
  const t = await getTranslations("pages");
  const page = await getTranslations("audit");
  return (
    <main
      id="main"
      className="group/audit mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        title={t("audit")}
        eyebrow={page("eyebrow")}
        description={page("description")}
        meta={
          <p className="font-mono text-[11.5px] text-dim">
            {page("retentionLine", { org: ctx.orgSlug })}
          </p>
        }
        actions={<AuditHeaderAction />}
      />
      <Suspense fallback={<AuditSkeleton />}>
        <Audit ctx={ctx} source={dataSource()} tab={tab} searchParams={{}} />
      </Suspense>
    </main>
  );
}
