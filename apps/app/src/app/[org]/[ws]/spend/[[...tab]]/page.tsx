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
// finding's evidence is a dialog over the Findings tab, opened by `?finding=`.
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
  const view = parseSpendView(segments, query.finding);
  if (view === null) notFound();
  const ctx = await requireViewer(org, ws);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Spend ctx={ctx} source={dataSource()} view={view} />
    </main>
  );
}
