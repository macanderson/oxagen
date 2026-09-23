import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { WelcomeInstaller } from "@/features/onboarding";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("installer") };
}

// The installer package's own screens, opened from Start a run. They sit in
// the auth shell with no rail: the package, not Oxagen, renders them.
export default async function WelcomeInstallerPage({
  params,
  searchParams,
}: PageProps<"/welcome/[org]/[ws]/installer">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const agent = firstParam((await searchParams).agent) ?? null;
  return (
    <Suspense>
      <WelcomeInstaller ctx={ctx} source={dataSource()} agent={agent} />
    </Suspense>
  );
}
