import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Agents, AgentsCreate, AgentsLoading } from "@/features/agents";
import { getAuthUser } from "@/features/auth";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("agents") };
}

// The column set (Composition or Operations) is the table's own session
// state, not a query parameter, so a link here always lands on Composition
// (mockups/pages/agents.md, Functionality). While the read is in flight the
// body is the skeleton and the shell stays; a state with nothing to list
// replaces the body, header included, as the design draws it.
export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const { cursor } = await searchParams;
  const t = await getTranslations();
  // The denied state names who is signed in; the session requireViewer read.
  const user = await getAuthUser();
  const viewerName = user === null ? "" : user.name || user.email;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<AgentsLoading />}>
        <Agents
          ctx={ctx}
          source={dataSource()}
          cursor={firstParam(cursor) ?? null}
          viewerName={viewerName}
          header={
            <PageHeader
              eyebrow={ctx.wsName}
              title={t("pages.agents")}
              description={t("agents.list.description")}
              actions={<AgentsCreate org={org} ws={ws} />}
            />
          }
        />
      </Suspense>
    </main>
  );
}
