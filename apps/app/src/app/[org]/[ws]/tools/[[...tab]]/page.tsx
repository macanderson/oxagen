import { getTranslations } from "next-intl/server";
import { NotRecorded } from "@/ui/not-recorded";
import { PageHeader } from "@/ui/page-header";

// One NotRecorded state until the #2958 lane lands its app half (ARCHITECTURE.md §1.2).
export default async function ToolsPage() {
  const t = await getTranslations("routes");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("tools.title")} />
      <NotRecorded section="tools" />
    </main>
  );
}
