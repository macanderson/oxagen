import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Fleet } from "@/features/fleet";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("fleet") };
}

export default async function FleetPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const { cursor } = await searchParams;
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("fleet")} />
      <Fleet
        ctx={ctx}
        source={dataSource()}
        cursor={firstParam(cursor) ?? null}
      />
    </main>
  );
}
