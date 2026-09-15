import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/ui/page-header";

// The title alone until WL-32 makes / a redirect to the viewer's first workspace (ARCHITECTURE.md §1.2).
export default async function HomePage() {
  const t = await getTranslations("routes");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("home.title")} />
    </main>
  );
}
