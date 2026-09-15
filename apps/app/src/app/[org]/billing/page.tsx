import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("billing") };
}

// The title alone until WL-38 builds the Billing page (ARCHITECTURE.md §8).
export default async function BillingPage({
  params,
}: PageProps<"/[org]/billing">) {
  const { org } = await params;
  await requireViewer(org);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("billing")} />
    </main>
  );
}
