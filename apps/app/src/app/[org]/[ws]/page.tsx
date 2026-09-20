import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Fleet } from "@/features/fleet";
import { OnboardingGate } from "@/features/onboarding";
import { FleetSpendTiles } from "@/features/spend";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("fleet") };
}

// The Fleet page (WL-34) with the cost rollup's two tiles (#2962) under its
// title.
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
      <OnboardingGate ctx={ctx} source={dataSource()} />
      <Fleet
        ctx={ctx}
        source={dataSource()}
        cursor={firstParam(cursor) ?? null}
        spendTiles={
          <FleetSpendTiles ctx={ctx} source={dataSource()} embedded />
        }
      />
    </main>
  );
}
