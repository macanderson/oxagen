import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Billing } from "@/features/billing";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("billing") };
}

export default async function BillingPage({
  params,
  searchParams,
}: PageProps<"/[org]/billing">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const { checkout, cursor } = await searchParams;
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("billing")} />
      <Billing
        ctx={ctx}
        source={dataSource()}
        checkout={firstParam(checkout) ?? null}
        cursor={firstParam(cursor) ?? null}
      />
    </main>
  );
}
