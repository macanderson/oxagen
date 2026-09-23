import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Agent } from "@/features/agents";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("agent") };
}

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
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("agent")}
      />
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
