import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { ContextPrPage, proposalListFrom } from "@/features/steering";
import { requireViewer } from "@/server/viewer";

// The document title names the Context PR by its proposal id, the one the
// route carries; the page's h1 is the record's lineage.
export async function generateMetadata({
  params,
}: PageProps<"/[org]/[ws]/steering/proposals/prs/[proposal]">): Promise<Metadata> {
  const { proposal } = await params;
  const t = await getTranslations("pages");
  return { title: `${proposal} · ${t("contextPr")}` };
}

// One Context PR (#5077): the record it would publish, the pull request with
// its checks and the writes its state allows, the diff, the support and what
// happened to it. The list's state, size and offset ride along as query
// values, so the way back lands on the list as it was left. A proposal id
// nothing holds is a 404.
export default async function ContextPrRoute({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/steering/proposals/prs/[proposal]">) {
  const { org, ws, proposal } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  return (
    <ContextPrPage
      ctx={ctx}
      source={dataSource()}
      proposalId={proposal}
      from={proposalListFrom(query)}
    />
  );
}
