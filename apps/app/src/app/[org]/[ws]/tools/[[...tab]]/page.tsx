import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  parseStudioRoute,
  StudioLoading,
  StudioServer,
} from "@/features/mcp-studio";
import { parseToolsTab, Tools, ToolsLoading } from "@/features/tools";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata({
  params,
}: PageProps<"/[org]/[ws]/tools/[[...tab]]">): Promise<Metadata> {
  const { tab: segments } = await params;
  const studio = parseStudioRoute(segments);
  if (studio !== null && studio !== undefined) {
    const t = await getTranslations("mcpStudio");
    return { title: t("title") };
  }
  const t = await getTranslations("pages");
  return { title: t("tools") };
}

// Tools (mockup `tools.md`, route `tools[/<tab>]`): the five tabs are path
// segments on this one route. `/tools/servers` and the `?tab=` links written
// before the tabs became segments land on the tab that absorbed them; a path
// deeper than one segment names no page and is a 404.
//
// The one deeper path is MCP Studio (#4678): `/tools/servers/<mcs_id>[/<tab>]`
// is one server's page, inside the same frame and fallback shape as Tools.
// parseStudioRoute answers first, and a Studio path that names no page (a
// bad id, an unknown tab) is a 404 too.
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
  const studio = parseStudioRoute(segments);
  if (studio === null) notFound();
  if (studio !== undefined) {
    const ctx = await requireViewer(org, ws);
    return (
      <Suspense fallback={<StudioLoading />}>
        <StudioServer ctx={ctx} source={dataSource()} route={studio} />
      </Suspense>
    );
  }
  const query = await searchParams;
  const legacy = query.tab;
  const tab = parseToolsTab(
    segments,
    typeof legacy === "string" ? legacy : undefined,
  );
  if (tab === null) notFound();
  const ctx = await requireViewer(org, ws);
  return (
    <Suspense fallback={<ToolsLoading />}>
      <Tools ctx={ctx} source={dataSource()} tab={tab} searchParams={query} />
    </Suspense>
  );
}
