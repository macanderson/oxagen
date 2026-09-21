import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { AgentSource } from "@/features/agents";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("agentSource") };
}

export default async function AgentSourcePage({
  params,
}: PageProps<"/[org]/[ws]/agents/[agent]/source">) {
  const { org, ws, agent } = await params;
  const ctx = await requireViewer(org, ws);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("agentSource")}
      />
      <AgentSource ctx={ctx} source={dataSource()} agent={agent} />
    </main>
  );
}
