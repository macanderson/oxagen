import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Runtime } from "@/features/runtimes";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("runtimes") };
}

// One runtime (roadmap mockups/pages/runtimes.md, Runtime detail), addressed by
// its enrollment's public id. An id the workspace does not hold is a 404.
export default async function RuntimePage({
  params,
}: {
  params: Promise<{ org: string; ws: string; runtime: string }>;
}) {
  const { org, ws, runtime } = await params;
  const ctx = await requireViewer(org, ws);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Runtime
        ctx={ctx}
        source={dataSource()}
        org={org}
        ws={ws}
        runtime={runtime}
      />
    </main>
  );
}
