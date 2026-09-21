import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Record, RecordLoading } from "@/features/record";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("record") };
}

// One published context record (#3395; ADR-061; MC spec §10.2). The route
// names the record by its lineage, which is the file stem under
// `.oxagen/rules/`: the same name the repository uses, so a reader who has the
// file has the address. The record's public id is not in the path, because a
// record read out of a file the registry has no row for has no public id, and
// the page still has to render it.
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
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<RecordLoading />}>
        <Record ctx={ctx} source={dataSource()} lineage={lineage} />
      </Suspense>
    </main>
  );
}
