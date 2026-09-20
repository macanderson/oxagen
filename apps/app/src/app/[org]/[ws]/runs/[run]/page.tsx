import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Run } from "@/features/run";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("run") };
}

// The Run page (WL-35, ARCHITECTURE.md §1.2): the run's header and one section
// chosen by `?tab=`. The tab, the transcript's zoom level and filter chips,
// the frames cursor and the open frame body are query values, so the run keeps
// one route.
export default async function RunPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/runs/[run]">) {
  const { org, ws, run } = await params;
  const ctx = await requireViewer(org, ws);
  const { tab, zoom, kinds, frames, body } = await searchParams;
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("run")}
      />
      <Run
        ctx={ctx}
        source={dataSource()}
        runId={run}
        tab={firstParam(tab) ?? null}
        zoom={firstParam(zoom) ?? null}
        kinds={firstParam(kinds) ?? null}
        frames={firstParam(frames) ?? null}
        body={firstParam(body) ?? null}
      />
    </main>
  );
}
