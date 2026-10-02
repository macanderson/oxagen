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
import { parseToolsTab } from "@/features/tools";
import { requireViewer } from "@/server/viewer";
import { permanentRedirectTo } from "@/shared/navigation";
import { firstParam, routes } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mcpStudio");
  return { title: t("title") };
}

// The Tools page is gone: its tabs are tabs of the Agents page (roadmap
// mockups `agents?tab=mcp-servers|policies|switches`). This route keeps two
// jobs.
//
// MCP Studio (#4678) still lives here: `/tools/servers/<mcs_id>[/<tab>]` is one
// server's page. It stays off `/agents/<segment>`, which is one agent's page.
// A Studio path that names no page (a bad id, an unknown tab) is a 404.
//
// Every other path moves, for a member of the workspace, to the Agents tab
// that absorbed it, with the query values the Tools views read: a bare
// `/tools` to MCP servers (roadmap mockups `AREA_ALIAS`), `/tools` with a
// registry filter to the registry, `/tools/providers` and `/tools/servers` to
// MCP servers, `/tools/policy` to Policies, `/tools/switches` to Off switches,
// and the `?tab=` links written before the tabs became segments to the tab
// that took each one. A path deeper than one segment names no page and is a 404.
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
  const registryQuery = ["category", "provider", "names", "cursor"].some(
    (key) => query[key] !== undefined,
  );
  const bare = segments === undefined || segments.length === 0;
  if (bare && legacy === undefined && !registryQuery)
    permanentRedirectTo(
      routes.agents(ctx.orgSlug, ctx.wsSlug, { tab: "mcp-servers" }),
    );
  permanentRedirectTo(
    routes.tools(ctx.orgSlug, ctx.wsSlug, {
      ...(tab === "tools" ? {} : { tab }),
      category: firstParam(query.category),
      provider: firstParam(query.provider),
      names: firstParam(query.names),
      rows: firstParam(query.rows),
      cursor: firstParam(query.cursor),
      belt: firstParam(query.belt),
    }),
  );
}
