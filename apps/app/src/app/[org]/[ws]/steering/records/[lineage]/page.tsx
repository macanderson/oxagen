import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Record, RecordLoading } from "@/features/record";
import { requireViewer } from "@/server/viewer";

// The document title names the record by its lineage, the file stem a reader
// who has the repository already knows it by.
export async function generateMetadata({
  params,
}: PageProps<"/[org]/[ws]/steering/records/[lineage]">): Promise<Metadata> {
  const { lineage } = await params;
  const t = await getTranslations("pages");
  return { title: `${lineage} · ${t("record")}` };
}

// One published context record (#3395; ADR-061; MC spec §10.2;
// mockups/pages/record.md). The route names the record by its lineage, which
// is the file stem under `.oxagen/rules/`: the same name the repository uses,
// so a reader who has the file has the address.
//
// The page renders no PageHeader: the record's own header belongs to the body,
// because it carries the statement, and a not-loaded state replaces the body
// rather than leaving a heading that discloses the record the reader was
// refused. A lineage nothing holds is a 404, never an empty page.
export default async function RecordPage({
  params,
}: PageProps<"/[org]/[ws]/steering/records/[lineage]">) {
  const { org, ws, lineage } = await params;
  const ctx = await requireViewer(org, ws);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6"
    >
      <Suspense fallback={<RecordLoading />}>
        <Record ctx={ctx} source={dataSource()} lineage={lineage} />
      </Suspense>
    </main>
  );
}
