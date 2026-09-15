import { getTranslations } from "next-intl/server";
import { NotRecorded } from "@/ui/not-recorded";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

// One NotRecorded state until the #2956 lane lands its app half (ARCHITECTURE.md §1.2).
export default async function AgentsPage({
  params,
}: PageProps<"/[org]/[ws]/agents">) {
  const { org, ws } = await params;
  await requireViewer(org, ws);
  const t = await getTranslations("routes");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("agents.title")} />
      <NotRecorded section="agents" />
    </main>
  );
}
