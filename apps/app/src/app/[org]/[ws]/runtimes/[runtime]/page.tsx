import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { getAuthUser } from "@/features/auth";
import { Runtime } from "@/features/runtimes";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("runtimes") };
}

// One runtime (roadmap mockups/pages/runtimes.md, Runtime detail), addressed by
// its enrollment's public id. A named runtime is addressed by its `rtm_` id
// instead, and its page carries the runtime's facts and its containment switch
// (ADR-204). An id the workspace does not hold is a 404.
export default async function RuntimePage({
  params,
}: {
  params: Promise<{ org: string; ws: string; runtime: string }>;
}) {
  const { org, ws, runtime } = await params;
  const ctx = await requireViewer(org, ws);
  // requireViewer admitted a session, so the memoized user is present; the
  // access-denied state names the person by it, as the mockup's does.
  const user = await getAuthUser();
  const viewerName = user === null ? "" : user.name || user.email;
  return (
    <Runtime
      ctx={ctx}
      source={dataSource()}
      org={org}
      ws={ws}
      runtime={runtime}
      viewerName={viewerName}
    />
  );
}
