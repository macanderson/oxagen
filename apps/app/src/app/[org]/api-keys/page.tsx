import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("apiKeys") };
}

// The title alone until WL-37 builds the API keys page (ARCHITECTURE.md §8).
export default async function ApiKeysPage({
  params,
}: PageProps<"/[org]/api-keys">) {
  const { org } = await params;
  await requireViewer(org);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("apiKeys")} />
    </main>
  );
}
