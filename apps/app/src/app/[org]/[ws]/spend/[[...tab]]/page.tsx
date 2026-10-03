import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { parseSpendView, Spend } from "@/features/spend";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("spend") };
}

// Spend (#2962; mockup route `spend[/<tab>[/<drill>]]`): the tab and one
// operator's, agent's or tool's drill are path segments on this one route, and
// a segment that names neither is a 404 rather than a page that guesses. One
// finding's evidence is a dialog over the Findings tab, opened by `?finding=`,
// a later page of the Findings list is `?cursor=`, and the Month tab's
// grouping is `?by=`.
// The feature renders the header, so a not-loaded state can replace the whole
// page body the way the design draws it.
export default async function SpendPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/spend/[[...tab]]">) {
  const [{ org, ws, tab: segments }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const view = parseSpendView(segments, query.finding, query.by, query.cursor);
  if (view === null) notFound();
  const ctx = await requireViewer(org, ws);
  return (
    <Spend ctx={ctx} source={dataSource()} view={view} />
  );
}
