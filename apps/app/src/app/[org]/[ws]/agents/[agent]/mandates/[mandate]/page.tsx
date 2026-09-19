import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Mandate, MandateLoading } from "@/features/mandate";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("mandate") };
}

// One mandate, under the agent that holds it (#2957; ADR-059). The search, the
// State facet and the pager are query values on this one route, so the lane adds
// no route of its own. The page renders no PageHeader: the mandate's own header
// is part of the body, because it names the mandate, and a not-loaded state
// replaces the body rather than leaving a heading that discloses what the reader
// was refused.
export default async function MandatePage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/agents/[agent]/mandates/[mandate]">) {
  const { org, ws, agent, mandate } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<MandateLoading />}>
        <Mandate
          ctx={ctx}
          source={dataSource()}
          agent={agent}
          mandate={mandate}
          searchParams={query}
        />
      </Suspense>
    </main>
  );
}
