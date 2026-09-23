import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { WelcomeLoading, WelcomeWrap } from "@/features/onboarding";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("welcomeWrap") };
}

// Onboarding step 2, Wrap an agent, in the gate shell rather than the app
// shell: the operator console does not open until the first frame arrives.
// `?agent=` names the identity the step enrols.
export default async function WelcomeWrapPage({
  params,
  searchParams,
}: PageProps<"/welcome/[org]/[ws]/wrap">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const agent = firstParam((await searchParams).agent) ?? null;
  return (
    <Suspense fallback={<WelcomeLoading step="wrap" />}>
      <WelcomeWrap ctx={ctx} source={dataSource()} agent={agent} />
    </Suspense>
  );
}
