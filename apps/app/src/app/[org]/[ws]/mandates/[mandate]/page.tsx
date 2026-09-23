import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { getAuthUser } from "@/features/auth";
import { Mandate, MandateLoading } from "@/features/mandate";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("mandate") };
}

// One mandate (#2957; ADR-059) at the flat route every other surface links to:
// `/{org}/{ws}/mandates/{mandate}`. The design's route nests the same page
// under its agent (`agents/[agent]/[tab]/[mandate]`), and both render the one
// feature. The ledger's search, facet, rows and pager are state in the table,
// so the page takes no query values.
//
// The page renders no PageHeader: the mandate's own header belongs to the body,
// because it names the mandate, and a not-loaded state replaces the body rather
// than leaving a heading that discloses the record the reader was refused.
export default async function MandatePage({
  params,
}: PageProps<"/[org]/[ws]/mandates/[mandate]">) {
  const { org, ws, mandate } = await params;
  const ctx = await requireViewer(org, ws);
  // The denied state names the person it refused (*Signed in as*); the
  // session is memoized for this request, so this reads nothing new.
  const user = await getAuthUser();
  const viewerName = user === null ? null : user.name || user.email;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<MandateLoading />}>
        <Mandate
          ctx={ctx}
          source={dataSource()}
          mandate={mandate}
          viewerName={viewerName}
        />
      </Suspense>
    </main>
  );
}
