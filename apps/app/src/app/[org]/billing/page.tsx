import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { getAuthUser } from "@/features/auth";
import { Billing } from "@/features/billing";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("billing") };
}

// Billing renders its own header: a not-loaded state replaces the page body,
// header included (pages/billing.md, States), so the h1 lives with the body
// that decides which state it is in. The title is the same `pages.billing`
// string generateMetadata returns, so the h1 and the document title agree.
export default async function BillingPage({
  params,
  searchParams,
}: PageProps<"/[org]/billing">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const { checkout, cursor } = await searchParams;
  const [t, user] = await Promise.all([
    getTranslations("pages"),
    getAuthUser(),
  ]);
  return (
    <Billing
      ctx={ctx}
      source={dataSource()}
      title={t("billing")}
      viewerName={user === null || user.name === "" ? null : user.name}
      checkout={firstParam(checkout) ?? null}
      cursor={firstParam(cursor) ?? null}
    />
  );
}
