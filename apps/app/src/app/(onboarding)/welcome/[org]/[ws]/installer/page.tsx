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

type WelcomeInstallerPageProps = PageProps<"/welcome/[org]/[ws]/installer">;

// The installer package's own screens, opened from Start a run. They sit in
// the auth shell with no rail: the package, not Oxagen, renders them. The
// route params, the viewer and the query are request data, so they are read
// inside <Suspense> (Cache Components).
export default function WelcomeInstallerPage(props: WelcomeInstallerPageProps) {
  return (
    <Suspense>
      <WelcomeInstallerStep {...props} />
    </Suspense>
  );
}

async function WelcomeInstallerStep({
  params,
  searchParams,
}: WelcomeInstallerPageProps) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const agent = firstParam((await searchParams).agent) ?? null;
  return <WelcomeInstaller ctx={ctx} source={dataSource()} agent={agent} />;
}
