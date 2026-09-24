import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Agent } from "@/features/agents";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("agent") };
}

// The agent page (spec pages/agent.md): the eyebrow says "Agent" and the h1
// is the agent card, both drawn by <Agent> once the identity is read, so the
// tab title is `pages.agent` and the h1 is the agent itself. A tab is a path
// segment; the bare route is Overview.
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string; agent: string; tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws, agent, tab } = await params;
  const ctx = await requireViewer(org, ws);
  const { cursor } = await searchParams;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Agent
        ctx={ctx}
        source={dataSource()}
        agent={agent}
        tab={firstParam(tab) ?? null}
        cursor={firstParam(cursor) ?? null}
      />
    </main>
  );
}
