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

// One mandate (#2957; ADR-059). The route is flat, as ARCHITECTURE.md §1.2
// states it: `/{org}/{ws}/mandates/{mandate}`. A mandate's public id identifies
// it inside the workspace on its own, so an agent segment above it would be a
// second name for the same record that nothing checks — and `get_mandate` takes
// the mandate id alone, so a wrong agent in the path would have changed nothing
// about what the page answered. The agent is reached from the record instead:
// the header links to the agent the mandate was granted to.
//
// The search, the State facet and the pager are query values on this one route,
// so the lane adds no route beyond this. The page renders no PageHeader: the
// mandate's own header belongs to the body, because it names the mandate, and a
// not-loaded state replaces the body rather than leaving a heading that
// discloses the record the reader was refused.
export default async function MandatePage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/mandates/[mandate]">) {
  const { org, ws, mandate } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<MandateLoading />}>
        <Mandate ctx={ctx} source={dataSource()} mandate={mandate} searchParams={query} />
      </Suspense>
    </main>
  );
}
