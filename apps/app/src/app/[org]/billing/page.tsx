import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Billing, BillingActions } from "@/features/billing";
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
  const [t, billing] = await Promise.all([
    getTranslations("pages"),
    getTranslations("billing.header"),
  ]);
  const source = dataSource();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        title={t("billing")}
        eyebrow={billing("eyebrow")}
        description={billing("description", { org: ctx.orgName })}
        actions={<BillingActions ctx={ctx} source={source} />}
      />
      <Billing
        ctx={ctx}
        source={source}
        checkout={firstParam(checkout) ?? null}
        cursor={firstParam(cursor) ?? null}
      />
    </main>
  );
}
