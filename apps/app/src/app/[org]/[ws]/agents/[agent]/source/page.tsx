import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { AgentSource } from "@/features/agents";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("agentSource") };
}

// The source editor (spec pages/agent-source.md): the eyebrow says "Agent
// source" and the h1 is the file path, both drawn by <AgentSource> once the
// identity is read, so the tab title is `pages.agentSource`.
export default async function AgentSourcePage({
  params,
}: PageProps<"/[org]/[ws]/agents/[agent]/source">) {
  const { org, ws, agent } = await params;
  const ctx = await requireViewer(org, ws);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <AgentSource ctx={ctx} source={dataSource()} agent={agent} />
    </main>
  );
}
