import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { parseToolsTab, Tools, ToolsLoading } from "@/features/tools";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("tools") };
}

// Tools (mockup `tools.md`, route `tools[/<tab>]`): the five tabs are path
// segments on this one route. `/tools/servers` and the `?tab=` links written
// before the tabs became segments land on the tab that absorbed them; a path
// deeper than one segment names no page and is a 404.
//
// The page renders no PageHeader of its own: the header belongs to the body,
// because a not-loaded state replaces the whole body (header, tabs and all)
// and never the shell. The body renders the header from the same `pages.tools`
// key this metadata uses, so the document title and the h1 cannot drift.
export default async function ToolsPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/tools/[[...tab]]">) {
  const { org, ws, tab: segments } = await params;
  const query = await searchParams;
  const legacy = query.tab;
  const tab = parseToolsTab(
    segments,
    typeof legacy === "string" ? legacy : undefined,
  );
  if (tab === null) notFound();
  const ctx = await requireViewer(org, ws);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<ToolsLoading />}>
        <Tools ctx={ctx} source={dataSource()} tab={tab} searchParams={query} />
      </Suspense>
    </main>
  );
}
