import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Run } from "@/features/run";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("run") };
}

// The Run page (WL-35, ARCHITECTURE.md §1.2, roadmap `mockups/pages/run.md`):
// the Run feature draws the whole body, its header included, because the
// design's header carries the eyebrow "Run", the run's id as the h1 in mono,
// and the run's actions in one row, and a not-loaded state replaces all of
// it. The tab, the transcript's filter chips, the frames cursor, the open
// frame body, and the spine's read fold and open groups are query values, so
// the run keeps one route.
export default async function RunPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/runs/[run]">) {
  const { org, ws, run } = await params;
  const ctx = await requireViewer(org, ws);
  const { tab, kinds, frames, body, reads, spine } = await searchParams;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-10"
    >
      <Run
        ctx={ctx}
        source={dataSource()}
        runId={run}
        tab={firstParam(tab) ?? null}
        kinds={firstParam(kinds) ?? null}
        frames={firstParam(frames) ?? null}
        body={firstParam(body) ?? null}
        reads={firstParam(reads) ?? null}
        spine={firstParam(spine) ?? null}
      />
    </main>
  );
}
