import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/ui/page-header";

// The title alone until WL-35 builds the Run page (ARCHITECTURE.md §8).
export default async function RunPage() {
  const t = await getTranslations("routes");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("run.title")} />
    </main>
  );
}
