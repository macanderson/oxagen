import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  AgentsArea,
  AgentsLoading,
  parseAgentsPageTab,
} from "@/features/agents";
import { getAuthUser } from "@/features/auth";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("agents") };
}

// Agents (roadmap mockups `agents`): the agents and what governs them, on one
// page. The tab is `?tab=`: Agents (left off), MCP servers (`mcp-servers`,
// with its `tools` and `toolbelts` views), Policies, Runtimes and Off
// switches. The old key `servers` still opens MCP servers. The Tools page and
// the Runtimes list redirect here. The column set (Composition
// or Operations) is the agents table's own session state, not a query
// parameter; `deregistered=show` is one because the server read changes with
// it. The header and the strip stay while a tab's reads run; a tab's body
// carries its own skeleton and its own not-loaded states.
export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const query = await searchParams;
  const tab = parseAgentsPageTab(firstParam(query.tab));
  // A tab's denied state names who is signed in; the session requireViewer read.
  const user = await getAuthUser();
  const viewerName = user === null ? "" : user.name || user.email;
  return (
    <Suspense fallback={<AgentsLoading />}>
      <AgentsArea
        ctx={ctx}
        source={dataSource()}
        tab={tab}
        searchParams={query}
        viewerName={viewerName}
      />
    </Suspense>
  );
}
