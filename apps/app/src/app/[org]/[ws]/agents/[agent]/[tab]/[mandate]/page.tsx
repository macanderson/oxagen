import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Mandate, MandateLoading } from "@/features/mandate";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("mandate") };
}

// One mandate at the design's route, nested under the agent it was granted to:
// `/{org}/{ws}/agents/{agent}/mandates/{mandate}`. It renders the same feature
// as the flat route. The segment above the id must read `mandates`, and the
// feature checks the agent slug against the record, so a wrong agent is a 404
// rather than a second, unchecked name for the mandate.
export default async function AgentMandatePage({
  params,
}: PageProps<"/[org]/[ws]/agents/[agent]/[tab]/[mandate]">) {
  const { org, ws, agent, tab, mandate } = await params;
  if (tab !== "mandates") notFound();
  const ctx = await requireViewer(org, ws);
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
          agent={agent}
        />
      </Suspense>
    </main>
  );
}
