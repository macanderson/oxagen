import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { getAuthUser } from "@/features/auth";
import { Runtimes } from "@/features/runtimes";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("runtimes") };
}

// Runtimes (roadmap mockups/pages/runtimes.md): the hosts agents run on. The
// feature renders the header itself, because the error and access-denied
// states replace the body with the header included.
export default async function RuntimesPage({
  params,
}: {
  params: Promise<{ org: string; ws: string }>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  // requireViewer admitted a session, so the memoized user is present; the
  // access-denied state names the person by it, as the mockup's does.
  const user = await getAuthUser();
  const viewerName = user === null ? "" : user.name || user.email;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Runtimes
        ctx={ctx}
        source={dataSource()}
        org={org}
        ws={ws}
        viewerName={viewerName}
      />
    </main>
  );
}
